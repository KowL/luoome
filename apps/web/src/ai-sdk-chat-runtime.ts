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
const CHAT_CONTEXT_LIMIT_TEXT =
  '本轮对话上下文仍超过运行时上限，请新建会话或缩小查询范围后重试；已保存的事实不会丢失。';
const PERSISTENCE_ERROR_TEXT = '助手回答保存失败；请读取会话核对，未保存草案不可确认。';
const HISTORY_LIMIT_TEXT =
  '本次对话历史超过本地运行时上下文上限，请新建会话后继续；已保存的事实不会丢失。';
const TOOL_ERROR_TEXT = '工具未完成，请核对实际结果。';
const TOOL_TIMEOUT_TEXT = '工具执行超时，请核对实际结果。';
const TOOL_OUTPUT_TRUNCATED_HINT =
  '工具输出超过单次上限，已截断；请缩小查询范围、分页或改用更精确的工具后重试。';
const CONTEXT_TOOL_DIGEST_HINT =
  '旧对话中的工具输出已按上下文预算压缩；需要该数据时重新调用工具获取。';
const DEFAULT_MAX_TOOL_CALLS = 8;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 32_768;
const DEFAULT_MAX_CONTEXT_CHARS = 48_000;
const DEFAULT_MAX_RUN_TIMEOUT_MS = 600_000;

/** 与 AI SDK 解耦的聊天模型描述，便于测试和后续从 agent profile 装配。 */
export interface AiSdkChatModel {
  readonly model: LanguageModel;
  readonly modelRef: string;
  /** 单次模型请求（step）预算；不等于整轮 run 预算。 */
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly maxSteps: number;
  readonly maxRetries: number;
  readonly maxTotalTokens: number;
  /** 整轮 run 预算；缺省按每一步的模型请求 + 工具等待派生，避免多步 Tool Calling 被截断。 */
  readonly runTimeoutMs?: number;
  /** 请求前投影后的上下文预算（字符）；缺省 48k。 */
  readonly maxContextChars?: number;
  /** 单个本地 Tool 输出回传模型的字节上限；缺省 32KB，外部 MCP 仍有自己的 64KB 限制。 */
  readonly maxToolOutputBytes?: number;
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
  readonly modelRef: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly durationMs: number;
  /** 供应商未回报 usage 时为 false：不能把缺失当成确定 0 成本。 */
  readonly tokensKnown: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

class ChatToolError extends Error {}

const jsonTextOf = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const utf8Prefix = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.byteLength <= maxBytes ? text : bytes.subarray(0, maxBytes).toString('utf8');
};

const isDraftOutput = (output: unknown): boolean =>
  output !== null &&
  typeof output === 'object' &&
  (output as { __luoomeDraft?: unknown }).__luoomeDraft === true;

const isDraftReceipt = (output: unknown): boolean =>
  output !== null &&
  typeof output === 'object' &&
  (output as { draftStatus?: unknown }).draftStatus !== undefined;

/**
 * 本地 Tool 输出回传模型前压到明确字节上限；草案不能被截断，否则用户无法确认原始输入。
 * 外部 MCP 的 64KB 限制在 client 侧独立生效，不经过这里。
 */
export const capToolOutput = (output: unknown, maxBytes: number): unknown => {
  if (output === null || output === undefined || isDraftOutput(output)) return output;
  const text = jsonTextOf(output);
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= maxBytes) return output;
  const previewBytes = Math.max(0, maxBytes - 256);
  return {
    outputTruncated: true,
    totalBytes,
    limitBytes: maxBytes,
    ...(Array.isArray(output) ? { totalItems: output.length } : {}),
    preview: utf8Prefix(text, previewBytes),
    hint: TOOL_OUTPUT_TRUNCATED_HINT,
  };
};

export interface ChatContextProjection {
  readonly messages: UIMessage[];
  readonly truncated: boolean;
  readonly chars: number;
}

const contextCharsOf = (value: unknown): number => jsonTextOf(value).length;

/**
 * 请求模型前的有界投影：先剔除只服务 UI 的 data part，再按体积压缩旧 Tool 输出。
 * 用户消息、最新助手回答和最新草案回执不允许丢弃；压缩后仍超限则明确拒绝，不静默丢事实。
 */
export const projectChatContext = (
  messages: readonly UIMessage[],
  maxChars: number,
): ChatContextProjection => {
  const projected = messages.map((message) => ({
    ...message,
    parts: (message.parts as readonly Record<string, unknown>[]).filter(
      (part) => !String(part.type ?? '').startsWith('data-'),
    ),
  })) as unknown as UIMessage[];
  let chars = contextCharsOf(projected);
  if (chars <= maxChars) return { messages: projected, truncated: false, chars };

  const lastAssistantIndex = projected.reduce(
    (index, message, current) => (message.role === 'assistant' ? current : index),
    -1,
  );
  const shrink = (messageIndex: number, partIndex: number): boolean => {
    const message = projected[messageIndex] as unknown as { parts: Record<string, unknown>[] };
    const part = message.parts[partIndex];
    if (part === undefined || part.output === undefined || part.output === null) return false;
    const nextPart = {
      ...part,
      output: {
        outputTruncated: true,
        totalChars: contextCharsOf(part.output),
        hint: CONTEXT_TOOL_DIGEST_HINT,
      },
    };
    chars = chars - contextCharsOf(part) + contextCharsOf(nextPart);
    message.parts[partIndex] = nextPart;
    return true;
  };
  const candidatesOf = (
    from: number,
    to: number,
    skip: (output: unknown) => boolean,
  ): { messageIndex: number; partIndex: number; size: number }[] => {
    const candidates: { messageIndex: number; partIndex: number; size: number }[] = [];
    for (let messageIndex = from; messageIndex < to; messageIndex += 1) {
      const parts = (projected[messageIndex] as unknown as { parts: Record<string, unknown>[] })
        .parts;
      parts.forEach((part, partIndex) => {
        if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) return;
        if (skip(part.output)) return;
        candidates.push({ messageIndex, partIndex, size: contextCharsOf(part.output) });
      });
    }
    return candidates.sort((left, right) => right.size - left.size);
  };

  let truncated = false;
  // 旧轮次的 Tool 输出最不新鲜，先按体积从大到小压缩。
  for (const candidate of candidatesOf(0, Math.max(lastAssistantIndex, 0), isDraftOutput)) {
    if (chars <= maxChars) break;
    truncated = shrink(candidate.messageIndex, candidate.partIndex) || truncated;
  }
  // 仍超限时才压缩最新助手回答里的普通 Tool 输出；草案与草案回执始终保留。
  if (chars > maxChars && lastAssistantIndex >= 0) {
    for (const candidate of candidatesOf(
      lastAssistantIndex,
      projected.length,
      (output) => isDraftOutput(output) || isDraftReceipt(output),
    )) {
      if (chars <= maxChars) break;
      truncated = shrink(candidate.messageIndex, candidate.partIndex) || truncated;
    }
  }
  if (chars > maxChars) throw new ChatRuntimeRejection(CHAT_CONTEXT_LIMIT_TEXT, 409);
  return { messages: projected, truncated, chars };
};

/**
 * 整轮 run 预算不能等于单次请求预算：每一步都可能同时消耗模型请求与工具等待预算，
 * 因此缺省按 maxSteps 派生，让多步 Tool Calling 有完整的步数空间。
 */
export const resolveRunTimeoutMs = (
  model: {
    readonly timeoutMs: number;
    readonly maxSteps: number;
    readonly runTimeoutMs?: number | undefined;
  },
  toolTimeoutMs: number,
): number =>
  model.runTimeoutMs ??
  Math.min((model.timeoutMs + toolTimeoutMs) * model.maxSteps, DEFAULT_MAX_RUN_TIMEOUT_MS);

const isTimeoutError = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; current !== null && typeof current === 'object' && depth < 5; depth += 1) {
    const name = (current as { name?: unknown }).name;
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

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
    const maxToolCalls = this.options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    const toolTimeoutMs = this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const maxToolOutputBytes =
      this.options.model.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES;
    const maxContextChars = this.options.model.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
    // AI SDK v6 的 timeout 是唯一能区分单次请求与整轮 run 的控制点：
    // stepMs 只覆盖单次模型请求，totalMs 覆盖整轮；abortSignal 仅用于客户端取消。
    const stepTimeoutMs = this.options.model.timeoutMs;
    const runTimeoutMs = resolveRunTimeoutMs(this.options.model, toolTimeoutMs);
    const signal = request.abortSignal;
    const signalOption = signal === undefined ? {} : { abortSignal: signal };
    const startedAt = Date.now();
    // 上下文预算在模型调用前有界投影；压缩后仍超限直接拒绝，不静默丢关键事实。
    const projection = projectChatContext(uiMessages, maxContextChars);

    let toolCalls = 0;
    let activeTools = 0;
    const totals = {
      steps: 0,
      tokensKnown: false,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    let failureText: string | undefined;
    let aborted = false;
    let timedOut = false;

    let externalTools: readonly ExternalMcpCallable[] = [];
    if (execution !== undefined && this.options.externalMcp !== undefined) {
      // 每轮重新发现：MCP 设置变更后下一轮立即生效，不缓存旧授权。
      externalTools = await this.options.externalMcp(
        signal === undefined ? execution.context : { ...execution.context, abortSignal: signal },
        execution.scenario.id,
      );
    }

    const tools: ToolSet = {};
    const registerTool = (
      callable: AgentCallableTool,
      authorization?: { readonly authorized: () => Promise<boolean>; readonly required: string },
      options: { readonly capOutput?: boolean } = {},
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
            if (result.ok || isBusinessError(result.output)) {
              // 外部 MCP 已在 client 侧限 64KB，不再叠加本地上限。
              return options.capOutput === false
                ? result.output
                : capToolOutput(result.output, maxToolOutputBytes);
            }
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
      registerTool(
        entry.callable,
        { authorized: entry.authorized, required: `mcp:${entry.service}` },
        { capOutput: false },
      );
    }

    const stream = createUIMessageStream<UIMessage>({
      originalMessages: uiMessages,
      generateId: () => messageId,
      onError: publicErrorText,
      execute: async ({ writer }) => {
        try {
          const messages = await convertToModelMessages(projection.messages, { tools });
          const result = streamText({
            model: this.options.model.model,
            system: request.instructions,
            messages,
            tools,
            stopWhen: [
              stepCountIs(this.options.model.maxSteps),
              ({ steps }) => totalTokensOf(steps) >= this.options.model.maxTotalTokens,
            ],
            maxRetries: this.options.model.maxRetries,
            maxOutputTokens: this.options.model.maxOutputTokens,
            timeout: { stepMs: stepTimeoutMs, totalMs: runTimeoutMs },
            ...signalOption,
            onError: ({ error }) => {
              // 超时不是用户取消：没有用户 abort 的 Abort/Timeout 错误按超时报告。
              failureText =
                signal?.aborted !== true && isTimeoutError(error)
                  ? CHAT_TIMEOUT_TEXT
                  : publicErrorText(error);
              execution?.context.logger.warn('[chat] 模型调用失败', { err: String(error) });
            },
            onAbort: () => {
              aborted = true;
            },
            onStepFinish: (step) => {
              totals.steps += 1;
              const stepUsage = step.usage;
              if (
                stepUsage.inputTokens !== undefined ||
                stepUsage.outputTokens !== undefined ||
                stepUsage.totalTokens !== undefined
              ) {
                totals.tokensKnown = true;
                totals.inputTokens += stepUsage.inputTokens ?? 0;
                totals.outputTokens += stepUsage.outputTokens ?? 0;
                totals.totalTokens +=
                  stepUsage.totalTokens ??
                  (stepUsage.inputTokens ?? 0) + (stepUsage.outputTokens ?? 0);
              }
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
                onError: (error) => failureText ?? publicErrorText(error),
                onFinish: ({ responseMessage: message, isAborted }) => {
                  responseMessage = message;
                  innerAborted = isAborted;
                },
              })
              .pipeThrough(
                new TransformStream<UIMessageChunk, UIMessageChunk>({
                  transform(chunk, controller) {
                    // AI SDK 把 stepMs/totalMs 的 abort 也送到同一个 abort chunk；
                    // 只有调用方 abortSignal 才算用户取消，其余按超时转成 error。
                    if (chunk.type === 'abort' && request.abortSignal?.aborted !== true) {
                      timedOut = true;
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
                    const cancelled =
                      !timedOut &&
                      (innerAborted || aborted || request.abortSignal?.aborted === true);
                    const failed = !cancelled && failureText !== undefined;
                    const usage: ChatUsage | undefined =
                      totals.steps === 0
                        ? undefined
                        : {
                            modelRef: this.options.model.modelRef,
                            steps: totals.steps,
                            toolCalls,
                            durationMs: Date.now() - startedAt,
                            tokensKnown: totals.tokensKnown,
                            ...(totals.tokensKnown
                              ? {
                                  inputTokens: totals.inputTokens,
                                  outputTokens: totals.outputTokens,
                                  totalTokens: totals.totalTokens,
                                }
                              : {}),
                          };
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
  maxContextChars: profile.maxContextChars,
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
