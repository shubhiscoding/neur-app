import { revalidatePath } from 'next/cache';

import {
  CoreAssistantMessage,
  CoreTool,
  CoreToolMessage,
  DataStreamWriter,
  Message,
  NoSuchToolError,
  Output,
  appendResponseMessages,
  createDataStreamResponse,
  generateObject,
  smoothStream,
  streamText,
} from 'ai';
import { performance } from 'perf_hooks';
import { aborted } from 'util';
import { z } from 'zod';

import {
  defaultModel,
  defaultSystemPrompt,
  defaultTools,
  getToolsFromRequiredTools,
  openai,
} from '@/ai/providers';
import { swapTokens } from '@/ai/tools/swap';
import { MAX_TOKEN_MESSAGES } from '@/lib/constants';
import { isValidTokenUsage, logWithTiming } from '@/lib/utils';
import {
  ResponseMessage,
  getConfirmationResult,
  getToolUpdateMessage,
  handleToolUpdateMessage,
} from '@/lib/utils/ai';
import { generateUUID } from '@/lib/utils/format';
import { generateTitleFromUserMessage } from '@/server/actions/ai';
import { getToolsFromOrchestrator } from '@/server/actions/orchestrator';
import { verifyUser } from '@/server/actions/user';
import {
  dbCreateConversation,
  dbCreateMessages,
  dbCreateTokenStat,
  dbDeleteConversation,
  dbGetConversationMessages,
} from '@/server/db/queries';

export const maxDuration = 120;

export async function POST(req: Request) {
  const startTime = performance.now();

  // Check for valid user session and required parameters
  const session = await verifyUser();
  const userId = session?.data?.data?.id;
  const publicKey = session?.data?.data?.publicKey;
  const degenMode = session?.data?.data?.degenMode;

  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  if (!publicKey) {
    console.error('[chat/route] No public key found');
    return new Response('No public key found', { status: 400 });
  }

  try {
    // Get the (newest) message sent to the API
    const { id: conversationId, message }: { id: string; message: Message } =
      await req.json();
    if (!message) return new Response('No message found', { status: 400 });
    logWithTiming(startTime, '[chat/route] message received');

    // Fetch existing messages for the conversation
    const existingMessages =
      (await dbGetConversationMessages({
        conversationId,
        limit: MAX_TOKEN_MESSAGES,
        isServer: true,
      })) ?? [];

    logWithTiming(startTime, '[chat/route] fetched existing messages');

    if (existingMessages.length === 0 && message.role !== 'user') {
      return new Response('No user message found', { status: 400 });
    }

    // Create a new conversation if it doesn't exist
    if (existingMessages.length === 0) {
      const title = await generateTitleFromUserMessage({
        message: message.content,
      });
      await dbCreateConversation({ conversationId, userId, title });
      revalidatePath('/api/conversations');
    }

    // Create a new user message in the DB if the current message is from the user
    const newUserMessage =
      message.role === 'user'
        ? await dbCreateMessages({
            messages: [
              {
                id: generateUUID(),
                conversationId,
                role: 'user',
                content: message.content,
                toolInvocations: [],
                experimental_attachments: message.experimental_attachments
                  ? JSON.parse(JSON.stringify(message.experimental_attachments))
                  : undefined,
              },
            ],
          })
        : null;

    const toolUpdateMessage = getToolUpdateMessage(message, existingMessages);

    if (
      toolUpdateMessage.toolCallId !== undefined &&
      toolUpdateMessage.toolName !== undefined &&
      toolUpdateMessage.messageIdToUpdate !== undefined &&
      toolUpdateMessage.toolCallResults?.step !== 'completed' &&
      message
    ) {
      if (message.role === 'assistant') {
        return new Response('OK', { status: 200 });
      }
      return handleToolUpdateMessage(toolUpdateMessage, message);
    }

    // Build the system prompt and append the history of attachments
    const attachments = existingMessages
      .filter((m) => m.experimental_attachments)
      .flatMap((m) => m.experimental_attachments!)
      .map((a) => ({ type: a.contentType, data: a.url }));

    const systemPrompt = [
      defaultSystemPrompt,
      `History of attachments: ${JSON.stringify(attachments)}`,
      `User Solana wallet public key: ${publicKey}`,
      `User ID: ${userId}`,
      `Conversation ID: ${conversationId}`,
      `Degen Mode: ${degenMode}`,
    ].join('\n\n');

    // Filter out empty messages and ensure sorting by createdAt ascending
    const relevant = existingMessages
      .filter((m) => m.content !== '')
      .sort(
        (a, b) => (a.createdAt?.getTime() || 0) - (b.createdAt?.getTime() || 0),
      );

    // Convert the message to a confirmation ('confirm' or 'deny') if it is for a confirmation prompt, otherwise add it to the relevant messages
    const confirmationResult = getConfirmationResult(message);
    if (confirmationResult !== undefined) {
      // Fake message to provide the confirmation selection to the model
      relevant.push({
        id: message.id,
        content: confirmationResult,
        role: 'user',
        createdAt: new Date(),
      });
    } else {
      relevant.push(message);
    }

    logWithTiming(startTime, '[chat/route] calling createDataStreamResponse');

    const abortData = {
      aborted: false,
      abortController: new AbortController(),
    };

    // Begin the stream response
    return createDataStreamResponse({
      execute: async (dataStream) => {
        if (dataStream.onError) {
          dataStream.onError((error: any) => {
            console.error(
              '[chat/route] createDataStreamResponse.execute dataStream error:',
              error,
            );
          });
        }

        // Exclude the confirmation tool if we are handling a confirmation
        const { toolsRequired, usage: orchestratorUsage } =
          await getToolsFromOrchestrator(relevant, degenMode || false);

        console.log('toolsRequired', toolsRequired);

        logWithTiming(
          startTime,
          '[chat/route] getToolsFromOrchestrator complete',
        );

        // Get a list of required tools from the orchestrator
        const tools = toolsRequired
          ? getToolsFromRequiredTools(toolsRequired)
          : defaultTools;

        const responses: ResponseMessage[] = [];

        // Begin streaming text from the model
        const result = streamText({
          model: defaultModel,
          system: systemPrompt,
          tools: {
            swapTokens: swapTokens({
              dataStream,
              abortData,
              extraData: { walletAddress: publicKey, askForConfirmation: true },
            }),
          },
          abortSignal: abortData?.abortController?.signal,
          experimental_toolCallStreaming: true,
          experimental_telemetry: {
            isEnabled: true,
            functionId: 'stream-text',
          },
          experimental_repairToolCall: async ({
            toolCall,
            tools,
            parameterSchema,
            error,
          }) => {
            if (NoSuchToolError.isInstance(error)) {
              return null;
            }

            console.log('[chat/route] repairToolCall', toolCall);

            const tool = tools[toolCall.toolName as keyof typeof tools];
            const { object: repairedArgs } = await generateObject({
              model: defaultModel,
              schema: tool.parameters as z.ZodType<any>,
              prompt: [
                `The model tried to call the tool "${toolCall.toolName}"` +
                  ` with the following arguments:`,
                JSON.stringify(toolCall.args),
                `The tool accepts the following schema:`,
                JSON.stringify(parameterSchema(toolCall)),
                'Please fix the arguments.',
              ].join('\n'),
            });
            return { ...toolCall, args: JSON.stringify(repairedArgs) };
          },
          experimental_transform: smoothStream(),
          maxSteps: 15,
          messages: relevant,
          onStepFinish: async (step) => {
            responses.push(...step.response.messages);
            if (abortData.aborted && userId) {
              await saveResponses(dataStream, responses, conversationId);
            }
          },
          async onFinish({ response, usage }) {
            if (!userId) return;
            try {
              logWithTiming(
                startTime,
                '[chat/route] streamText.onFinish complete',
              );

              const saved = await saveResponses(
                dataStream,
                responses,
                conversationId,
              );

              logWithTiming(
                startTime,
                '[chat/route] dbCreateMessages complete',
              );

              // Save the token stats
              if (saved && newUserMessage && isValidTokenUsage(usage)) {
                let { promptTokens, completionTokens, totalTokens } = usage;

                if (isValidTokenUsage(orchestratorUsage)) {
                  promptTokens += orchestratorUsage.promptTokens;
                  completionTokens += orchestratorUsage.completionTokens;
                  totalTokens += orchestratorUsage.totalTokens;
                }

                const messageIds = [...newUserMessage, ...saved].map(
                  (m) => m.id,
                );

                await dbCreateTokenStat({
                  userId,
                  messageIds,
                  promptTokens,
                  completionTokens,
                  totalTokens,
                });

                logWithTiming(
                  startTime,
                  '[chat/route] dbCreateTokenStat complete',
                );
              }

              revalidatePath('/api/conversations');
            } catch (error) {
              console.error('[chat/route] Failed to save messages', error);
            }
          },
        });
        result.mergeIntoDataStream(dataStream);
      },
      onError: (_) => {
        return 'An error occurred';
      },
    });
  } catch (error) {
    console.error('[chat/route] Unexpected error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const session = await verifyUser();
  const userId = session?.data?.data?.id;

  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { id: conversationId } = await req.json();
    await dbDeleteConversation({ conversationId, userId });
    revalidatePath('/api/conversations');

    return new Response('Conversation deleted', { status: 200 });
  } catch (error) {
    console.error('[chat/route] Delete error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function saveResponses(
  dataStream: DataStreamWriter,
  responseMessages: ResponseMessage[],
  conversationId: string,
) {
  try {
    const finalMessages = appendResponseMessages({
      messages: [],
      responseMessages: responseMessages,
    }).filter(
      (m) =>
        // Accept either a non-empty message or a tool invocation
        m.content !== '' || (m.toolInvocations || []).length !== 0,
    );

    finalMessages.forEach((m, index) => {
      if (m.createdAt) {
        m.createdAt = new Date(m.createdAt.getTime() + index);
      }
    });

    return await dbCreateMessages({
      messages: finalMessages.map((message) => {
        const messageId = generateUUID();

        if (message.role === 'assistant') {
          dataStream.writeMessageAnnotation({
            messageIdFromServer: messageId,
          });
        }

        return {
          id: messageId,
          conversationId,
          createdAt: message.createdAt ?? new Date(),
          role: message.role,
          content: message.content,
          toolInvocations: message.toolInvocations
            ? JSON.parse(JSON.stringify(message.toolInvocations))
            : undefined,
          experimental_attachments: message.experimental_attachments
            ? JSON.parse(JSON.stringify(message.experimental_attachments))
            : undefined,
        };
      }),
    });
  } catch (error) {
    console.error('Failed to save chat');
  }
}
