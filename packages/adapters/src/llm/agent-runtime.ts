import type {
  AgentCallableTool,
  AgentRuntimeLike,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  AgentTokenUsage,
  AgentToolTrace,
  Logger,
} from '@luoome/core';
import {
  createAgentUIStreamResponse,
  NoObjectGeneratedError,
  Output,
  type StreamTextTransform,
  stepCountIs,
  type TextStreamPart,
  ToolLoopAgent,
  type ToolSet,
  tool,
} from 'ai';
import type { z } from 'zod';
import type { ResolvedAIModelProfile } from './model-catalog.js';
import {
  buildSystemContent,
  recoverMalformedText,
  toNormalizedJsonSchema,
} from './provider-quirks.js';
import { toValidatedAISchema } from './schema.js';

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_TOTAL_TOKENS = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TRACE_KEYS = 20;
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

const markerPrefixSuffixLength = (value: string, marker: string): number => {
  const limit = Math.min(value.length, marker.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (marker.startsWith(value.slice(-length))) return length;
  }
  return 0;
};

const stripThinkStream =
  <TOOLS extends ToolSet>(): StreamTextTransform<TOOLS> =>
  () => {
    let buffer = '';
    let insideThink = false;

    const drain = (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>,
      source: TextStreamPart<TOOLS>,
      final: boolean,
    ): void => {
      while (buffer.length > 0) {
        if (insideThink) {
          const closeAt = buffer.indexOf(THINK_CLOSE);
          if (closeAt >= 0) {
            buffer = buffer.slice(closeAt + THINK_CLOSE.length);
            insideThink = false;
            continue;
          }
          if (final) buffer = '';
          else buffer = buffer.slice(-markerPrefixSuffixLength(buffer, THINK_CLOSE));
          return;
        }

        const openAt = buffer.indexOf(THINK_OPEN);
        if (openAt >= 0) {
          const visible = buffer.slice(0, openAt);
          if (visible.length > 0 && source.type === 'text-delta') {
            controller.enqueue({ ...source, text: visible });
          }
          buffer = buffer.slice(openAt + THINK_OPEN.length);
          insideThink = true;
          continue;
        }

        const retained = final ? 0 : markerPrefixSuffixLength(buffer, THINK_OPEN);
        const visible = retained === 0 ? buffer : buffer.slice(0, -retained);
        if (visible.length > 0 && source.type === 'text-delta') {
          controller.enqueue({ ...source, text: visible });
        }
        buffer = retained === 0 ? '' : buffer.slice(-retained);
        return;
      }
    };

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(chunk, controller) {
        if (chunk.type === 'text-delta') {
          buffer += chunk.text;
          drain(controller, chunk, false);
          return;
        }
        if (chunk.type === 'text-end') {
          drain(controller, chunk, true);
          insideThink = false;
        }
        controller.enqueue(chunk);
      },
    });
  };

export interface AgentRuntimeConfig {
  readonly maxSteps: number;
  readonly maxTotalTokens: number;
  readonly timeoutMs: number;
}

export interface AISDKAgentRuntimeOptions {
  readonly logger: Logger;
  readonly config?: Partial<AgentRuntimeConfig>;
}

export interface AgentUIStreamRequest {
  readonly instructions: string;
  readonly uiMessages: readonly unknown[];
  readonly tools: readonly AgentCallableTool[];
  readonly abortSignal?: AbortSignal;
  readonly onFinish?: (message: {
    readonly id: string;
    readonly parts: readonly Record<string, unknown>[];
    /** 流被中断（abortSignal 触发）时为 true；parts 为已收到的部分。 */
    readonly cancelled: boolean;
  }) => Promise<void> | void;
}

const usageProjection = (
  usage:
    | {
        readonly inputTokens: number | undefined;
        readonly outputTokens: number | undefined;
        readonly totalTokens: number | undefined;
      }
    | undefined,
): AgentTokenUsage => ({
  inputTokens: usage?.inputTokens ?? 0,
  outputTokens: usage?.outputTokens ?? 0,
  totalTokens: usage?.totalTokens ?? 0,
});

const summarizeTraceOutput = (output: unknown): unknown => {
  if (output === null || typeof output !== 'object') return output;
  if (Array.isArray(output)) return { type: 'array', length: output.length };

  const record = output as Record<string, unknown>;
  const error = record.error;
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const kind = (error as Record<string, unknown>).kind;
    return {
      type: 'error',
      ...(typeof kind === 'string' ? { kind } : {}),
    };
  }
  const keys = Object.keys(record);
  return {
    type: 'object',
    keys: keys.slice(0, MAX_TRACE_KEYS),
    ...(keys.length > MAX_TRACE_KEYS ? { omittedKeyCount: keys.length - MAX_TRACE_KEYS } : {}),
  };
};

export class AISDKAgentRuntime implements AgentRuntimeLike {
  readonly name: string;

  private readonly logger: Logger;
  private readonly runtimeConfig: AgentRuntimeConfig;

  constructor(
    private readonly profile: ResolvedAIModelProfile,
    options: AISDKAgentRuntimeOptions,
  ) {
    this.name = `ai-sdk-agent:${profile.modelRef}`;
    this.logger = options.logger;
    this.runtimeConfig = {
      maxSteps: options.config?.maxSteps ?? profile.maxSteps ?? DEFAULT_MAX_STEPS,
      maxTotalTokens:
        options.config?.maxTotalTokens ?? profile.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS,
      timeoutMs: options.config?.timeoutMs ?? profile.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  async createUIMessageStreamResponse(request: AgentUIStreamRequest): Promise<Response> {
    const tools = Object.fromEntries(
      request.tools.map((callable) => [
        callable.name,
        tool({
          description: callable.description,
          inputSchema: toValidatedAISchema(callable.inputSchema as z.ZodType),
          execute: async (input) => {
            const result = await callable.execute(input);
            return result.output;
          },
        }),
      ]),
    );
    const agent = new ToolLoopAgent({
      model: this.profile.model,
      instructions: request.instructions,
      tools,
      stopWhen: [
        stepCountIs(this.runtimeConfig.maxSteps),
        ({ steps }) =>
          steps.reduce((sum, step) => sum + (step.usage.totalTokens ?? 0), 0) >=
          this.runtimeConfig.maxTotalTokens,
      ],
      maxRetries: this.profile.maxRetries,
      onStepFinish: (step) => {
        this.logger.debug('agent_ui_stream: step finished', {
          finishReason: step.finishReason,
          usage: usageProjection(step.usage),
          toolCalls: step.toolCalls.map((call) => call.toolName),
        });
      },
    });
    return createAgentUIStreamResponse({
      agent,
      uiMessages: [...request.uiMessages],
      ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
      timeout: { totalMs: this.runtimeConfig.timeoutMs },
      ...(this.profile.quirks.recoverMalformedText
        ? { experimental_transform: stripThinkStream<typeof tools>() }
        : {}),
      ...(request.onFinish === undefined
        ? {}
        : {
            onFinish: async ({ responseMessage, isAborted }) => {
              await request.onFinish?.({
                id: responseMessage.id,
                parts: responseMessage.parts as unknown as readonly Record<string, unknown>[],
                cancelled: isAborted,
              });
            },
          }),
    });
  }

  async run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    const outputSchema = request.outputSchema as z.ZodType;
    const trace: AgentToolTrace[] = [];
    let observedUsage: AgentTokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    const tools = Object.fromEntries(
      request.tools.map((callable) => [
        callable.name,
        tool({
          description: callable.description,
          inputSchema: toValidatedAISchema(callable.inputSchema as z.ZodType),
          execute: async (input) => {
            const startedAt = performance.now();
            const result = await callable.execute(input);
            trace.push({
              toolName: callable.name,
              input,
              output: summarizeTraceOutput(result.output),
              ok: result.ok,
              durationMs: performance.now() - startedAt,
            });
            return result.output;
          },
        }),
      ]),
    );
    const quirks = this.profile.quirks;
    const instructions = quirks.injectSchemaIntoSystem
      ? buildSystemContent(request.instructions, toNormalizedJsonSchema(outputSchema))
      : request.instructions;

    const agent = new ToolLoopAgent({
      model: this.profile.model,
      instructions,
      tools,
      stopWhen: [
        stepCountIs(this.runtimeConfig.maxSteps),
        ({ steps }) =>
          steps.reduce((sum, step) => sum + (step.usage.totalTokens ?? 0), 0) >=
          this.runtimeConfig.maxTotalTokens,
      ],
      output: Output.object({ schema: toValidatedAISchema(outputSchema) }),
      maxRetries: this.profile.maxRetries,
      onStepFinish: (step) => {
        const stepUsage = usageProjection(step.usage);
        observedUsage = {
          inputTokens: observedUsage.inputTokens + stepUsage.inputTokens,
          outputTokens: observedUsage.outputTokens + stepUsage.outputTokens,
          totalTokens: observedUsage.totalTokens + stepUsage.totalTokens,
        };
        this.logger.debug('agent_run: step finished', {
          finishReason: step.finishReason,
          usage: stepUsage,
          toolCalls: step.toolCalls.map((call) => call.toolName),
        });
      },
    });
    try {
      const result = await agent.generate({
        prompt: request.prompt,
        timeout: { totalMs: this.runtimeConfig.timeoutMs },
      });
      return {
        output: result.output,
        trace,
        usedTools: [...new Set(trace.map((entry) => entry.toolName))],
        totalUsage: usageProjection(result.totalUsage),
      };
    } catch (error) {
      if (
        quirks.recoverMalformedText &&
        NoObjectGeneratedError.isInstance(error) &&
        error.text !== undefined
      ) {
        return {
          output: recoverMalformedText(error.text, outputSchema),
          trace,
          usedTools: [...new Set(trace.map((entry) => entry.toolName))],
          totalUsage: observedUsage,
        };
      }
      throw error;
    }
  }
}
