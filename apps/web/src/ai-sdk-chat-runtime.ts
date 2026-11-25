import type { ResolvedAIModelProfile } from '@luoome/adapters';
import { loadAIModelCatalog, resolveMcpConfigPath, toValidatedAISchema } from '@luoome/adapters';
import type { AgentCallableTool, ToolContext } from '@luoome/core';
import { discoverExternalMcpTools, type ExternalMcpCallable } from '@luoome/tools';
import {
  tool as aiTool,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type LanguageModel,
  type LanguageModelUsage,
  stepCountIs,
  streamText,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import type { z } from 'zod';
import type { AISettingsStore } from './ai-settings.js';
import { ChatRuntimeRejection, type ChatStreamRuntime } from './chat.js';

const CHAT_ERROR_TEXT = '模型未完成回答，请显式重试或继续讨论；不代表没有机会。';
const CHAT_TIMEOUT_TEXT = '模型调用超时，请稍后重试；本次回答未完成。';
const PERSISTENCE_ERROR_TEXT = '助手回答保存失败；请读取会话核对，未保存草案不可确认。';
const HISTORY_LIMIT_TEXT =
  '本次对话历史超过本地运行时上下文上限，请新建会话后继续；已保存的事实不会丢失。';
const TOOL_ERROR_TEXT = '工具未完成，请核对实际结果。';
const TOOL_TIMEOUT_TEXT = '工具执行超时，请核对实际结果。';
const DEFAULT_MAX_TOOL_CALLS = 8;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

/** 与 AI SDK 解耦的聊天模型描述，便于测试和后续从 agent profile 装配。 */
export interface AiSdkChatModel {
  readonly model: LanguageModel;
  readonly modelRef: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly maxSteps: number;
  readonly maxRetries: number;
  readonly maxTotalTokens: number;
}

export interface AiSdkChatRuntimeOptions {
  readonly model: AiSdkChatModel;
  readonly maxToolCalls?: number;
  readonly toolTimeoutMs?: number;
  /**
   * 每轮按 ToolContext + 场景重新发现只读外部 MCP 工具。
   * 缺省时不接入外部 MCP；发现失败按聊天错误上报，不静默丢失外部能力。
   */
  readonly externalMcp?: (
    context: ToolContext,
    scenario: string,
  ) => Promise<readonly ExternalMcpCallable[]>;
}

interface ChatUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly steps: number;
}

class ChatToolError extends Error {}

const toChatUsage = (usage: LanguageModelUsage): ChatUsage => ({
  inputTokens: usage.inputTokens ?? 0,
  outputTokens: usage.outputTokens ?? 0,
  totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
  steps: 1,
});

const totalTokensOf = (steps: readonly { readonly usage: LanguageModelUsage }[]): number =>
  steps.reduce((total, step) => total + (step.usage.totalTokens ?? 0), 0);

const publicErrorText = (error: unknown): string => {
  if (error instanceof ChatToolError) return error.message;
  return CHAT_ERROR_TEXT;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  if (!(timeoutMs > 0)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ChatToolError(TOOL_TIMEOUT_TEXT)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const isBusinessError = (output: unknown): boolean =>
  output !== null && typeof output === 'object' && 'error' in output;

/**
 * 聊天工具的 Zod 输入里含 `z.coerce.date()` 等无法直接投影为 JSON Schema 的构造，
 * 必须经项目统一的归一化/校验投影；直接把 Zod 交给 AI SDK 会在建工具时抛错。
 */
const aiInputSchemaOf = (schema: unknown): ToolSet[string]['inputSchema'] =>
  schema !== null && typeof schema === 'object' && 'safeParse' in schema
    ? toValidatedAISchema(schema as z.ZodType)
    : (schema as ToolSet[string]['inputSchema']);

/**
 * Bun 进程内的 AI SDK v6 聊天运行时：服务端持有历史与工具，模型只负责选择工具和生成回答。
 * 草案工具与普通工具同权：执行结果原样回传并持久化，由 UI/用户决定是否确认。
 */
export class AiSdkChatRuntime implements ChatStreamRuntime {
  constructor(private readonly options: AiSdkChatRuntimeOptions) {}

  async createUIMessageStreamResponse(
    request: Parameters<ChatStreamRuntime['createUIMessageStreamResponse']>[0],
  ): Promise<Response> {
    const execution = request.execution;
    // 历史超限必须在落库与模型调用之前拒绝；运行时不做静默截断。
    if (execution?.historyTruncated === true) throw new ChatRuntimeRejection(HISTORY_LIMIT_TEXT);
    const uiMessages = request.uiMessages as UIMessage[];
    const messageId =
      execution === undefined ? `assistant_${crypto.randomUUID()}` : `assistant_${execution.runId}`;
    const timeout = new AbortController();
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      timeout.abort();
    }, this.options.model.timeoutMs);
    const signal =
      request.abortSignal === undefined
        ? timeout.signal
        : AbortSignal.any([request.abortSignal, timeout.signal]);

    const maxToolCalls = this.options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    const toolTimeoutMs = this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    let toolCalls = 0;
    let activeTools = 0;
    let usage: ChatUsage | undefined;
    let failureText: string | undefined;
    let aborted = false;

    let externalTools: readonly ExternalMcpCallable[] = [];
    if (execution !== undefined && this.options.externalMcp !== undefined) {
      try {
        // 每轮重新发现：MCP 设置变更后下一轮立即生效，不缓存旧授权。
        externalTools = await this.options.externalMcp(
          { ...execution.context, abortSignal: signal },
          execution.scenario.id,
        );
      } catch (error) {
        clearTimeout(timeoutTimer);
        throw error;
      }
    }

    const tools: ToolSet = {};
    const registerTool = (
      callable: AgentCallableTool,
      authorization?: { readonly authorized: () => Promise<boolean>; readonly required: string },
    ): void => {
      tools[callable.name] = aiTool({
        description: callable.description,
        inputSchema: aiInputSchemaOf(callable.inputSchema),
        execute: async (input: unknown) => {
          if (toolCalls >= maxToolCalls) {
            return {
              error: {
                kind: 'permission_denied',
                required: `每轮最多 ${maxToolCalls} 次工具调用`,
              },
            };
          }
          if (authorization !== undefined && !(await authorization.authorized())) {
            return {
              error: { kind: 'permission_denied', required: authorization.required },
            };
          }
          toolCalls += 1;
          activeTools += 1;
          // 超时只结束等待，底层调用可能仍在执行；executionStopped 必须等它真正结束。
          const pending = Promise.resolve().then(() => callable.execute(input));
          void pending
            .finally(() => {
              activeTools -= 1;
            })
            .catch(() => {});
          try {
            const result = await withTimeout(pending, toolTimeoutMs);
            // 业务错误（output.error）按工具结果回传，让模型看到失败原因后继续；
            // 其余失败按工具执行错误处理，由 AI SDK 回传 error-text。
            if (result.ok || isBusinessError(result.output)) return result.output;
            throw new ChatToolError(TOOL_ERROR_TEXT);
          } catch (error) {
            if (error instanceof ChatToolError) throw error;
            execution?.context.logger.warn('[chat] 工具执行失败', {
              tool: callable.name,
              err: String(error),
            });
            throw new ChatToolError(TOOL_ERROR_TEXT);
          }
        },
      });
    };

    for (const callable of request.tools) registerTool(callable);
    for (const entry of externalTools) {
      registerTool(entry.callable, {
        authorized: entry.authorized,
        required: `mcp:${entry.service}`,
      });
    }

    const stream = createUIMessageStream<UIMessage>({
      originalMessages: uiMessages,
      generateId: () => messageId,
      onError: publicErrorText,
      execute: async ({ writer }) => {
        try {
          const messages = await convertToModelMessages(uiMessages, { tools });
          const result = streamText({
            model: this.options.model.model,
            system: request.instructions,
            messages,
            tools,
            stopWhen: [
              stepCountIs(this.options.model.maxSteps),
              ({ steps }) => totalTokensOf(steps) >= this.options.model.maxTotalTokens,
            ],
            abortSignal: signal,
            maxRetries: this.options.model.maxRetries,
            maxOutputTokens: this.options.model.maxOutputTokens,
            onError: ({ error }) => {
              failureText = publicErrorText(error);
              execution?.context.logger.warn('[chat] 模型调用失败', { err: String(error) });
            },
            onAbort: () => {
              aborted = true;
            },
            onStepFinish: (step) => {
              const stepUsage = toChatUsage(step.usage);
              usage =
                usage === undefined
                  ? stepUsage
                  : {
                      inputTokens: usage.inputTokens + stepUsage.inputTokens,
                      outputTokens: usage.outputTokens + stepUsage.outputTokens,
                      totalTokens: usage.totalTokens + stepUsage.totalTokens,
                      steps: usage.steps + 1,
                    };
            },
          });
          let responseMessage: UIMessage | undefined;
          let innerAborted = false;
          let finishChunk: UIMessageChunk | undefined;
          writer.merge(
            result
              .toUIMessageStream({
                generateMessageId: () => messageId,
                sendReasoning: false,
                onError: publicErrorText,
                onFinish: ({ responseMessage: message, isAborted }) => {
                  responseMessage = message;
                  innerAborted = isAborted;
                },
              })
              .pipeThrough(
                new TransformStream<UIMessageChunk, UIMessageChunk>({
                  transform(chunk, controller) {
                    // 超时不是用户取消：把 abort 转成 error，避免 UI 误标为「已停止」。
                    if (chunk.type === 'abort' && timedOut) {
                      failureText = CHAT_TIMEOUT_TEXT;
                      controller.enqueue({ type: 'error', errorText: CHAT_TIMEOUT_TEXT });
                      return;
                    }
                    // finish 不能先于持久化送达：保存失败时调用方必须看到错误，而不是成功收尾。
                    if (chunk.type === 'finish') {
                      finishChunk = chunk;
                      return;
                    }
                    controller.enqueue(chunk);
                  },
                  flush: async (controller) => {
                    clearTimeout(timeoutTimer);
                    const cancelled =
                      !timedOut &&
                      (innerAborted || aborted || request.abortSignal?.aborted === true);
                    const failed = !cancelled && (timedOut || failureText !== undefined);
                    const usagePart =
                      usage === undefined
                        ? undefined
                        : ({ type: 'data-luoome-usage', data: { usage } } as const);
                    const parts = [
                      ...((responseMessage?.parts ?? []) as Record<string, unknown>[]),
                      ...(usagePart === undefined ? [] : [usagePart]),
                      ...(failed
                        ? [
                            {
                              type: 'data-luoome-stream-error',
                              data: { message: failureText ?? CHAT_ERROR_TEXT },
                            },
                          ]
                        : []),
                    ];
                    try {
                      await request.onFinish?.({
                        id: responseMessage?.id ?? messageId,
                        parts,
                        cancelled,
                        executionStopped: activeTools === 0,
                      });
                    } catch (error) {
                      execution?.context.logger.warn('[chat] assistant message 持久化失败', {
                        err: String(error),
                      });
                      controller.enqueue({ type: 'error', errorText: PERSISTENCE_ERROR_TEXT });
                      return;
                    }
                    if (usagePart !== undefined)
                      controller.enqueue(usagePart as unknown as UIMessageChunk);
                    if (finishChunk !== undefined) controller.enqueue(finishChunk);
                  },
                }),
              ),
          );
        } catch (error) {
          clearTimeout(timeoutTimer);
          failureText ??= publicErrorText(error);
          // 流尚未建立时没有 flush 机会；仍按聊天错误语义保存一条明确的错误记录。
          try {
            await request.onFinish?.({
              id: messageId,
              parts: [
                {
                  type: 'data-luoome-stream-error',
                  data: { message: failureText },
                },
              ],
              cancelled: false,
              executionStopped: activeTools === 0,
            });
          } catch (persistError) {
            execution?.context.logger.warn('[chat] assistant message 持久化失败', {
              err: String(persistError),
            });
          }
          throw error;
        }
      },
    });

    return createUIMessageStreamResponse({
      stream,
      headers: { 'x-luoome-chat-runtime': 'ai-sdk' },
    });
  }
}

const modelFromProfile = (profile: ResolvedAIModelProfile): AiSdkChatModel => ({
  model: profile.model,
  modelRef: profile.modelRef,
  timeoutMs: profile.timeoutMs,
  maxOutputTokens: profile.maxOutputTokens,
  maxSteps: profile.maxSteps,
  maxRetries: profile.maxRetries,
  maxTotalTokens: profile.maxTotalTokens,
});

/**
 * 从持久化 AI 设置/agent profile 装配聊天运行时。
 * 缺少有效密钥、目录或 profile 时返回 undefined，由调用方决定降级入口。
 */
export const createAiSdkChatRuntimeFromStore = (
  store?: AISettingsStore,
  envOverride?: Readonly<Record<string, string | undefined>>,
  options: { readonly fetchImpl?: typeof fetch } = {},
): AiSdkChatRuntime | undefined => {
  if (store === undefined) return undefined;
  const env = envOverride ?? store.runtimeEnv();
  const view = store.read();
  if (view.configError !== undefined || (env[view.apiKeyEnv]?.trim().length ?? 0) === 0)
    return undefined;
  try {
    const catalog = loadAIModelCatalog(
      env,
      options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    );
    const mcpConfigPath = resolveMcpConfigPath(env);
    return new AiSdkChatRuntime({
      model: modelFromProfile(catalog.resolve('agent')),
      ...(env.LUOOME_EXPOSE_EXTERNAL !== 'true'
        ? {}
        : {
            externalMcp: (context: ToolContext, scenario: string) =>
              discoverExternalMcpTools(mcpConfigPath, context, scenario),
          }),
    });
  } catch {
    return undefined;
  }
};
