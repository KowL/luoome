import type { LLMGenerateRequest, LLMProviderConfig } from '@luoome/core';
import { z } from 'zod';
import type { LLMAdapter, LLMGenerateResult } from './types.js';

/**
 * Anthropic Messages API 适配器（v0.2 起）。
 *
 * 设计要点：
 * - Anthropic 没有 response_format，但有 tool_use：定义 1 个 tool「emit_advice」，
 *   强制 LLM 调用并把结构化输出塞进 tool.input；用 tool_choice 锁定只调此 tool。
 * - schema 走 z.toJSONSchema 推导的 JSON Schema，与 OpenAI 兼容 adapter 行为一致。
 * - 不在 adapter 内做重试（fallback 协议由 Manager 处理）。
 */

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PROMPT_CHARS = 16_000;
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_TOOL_NAME = 'emit_advice';

export class AnthropicAdapterError extends Error {
  override readonly name = 'AnthropicAdapterError';
  constructor(
    message: string,
    override readonly cause?: unknown,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

interface AnthropicTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

interface AnthropicMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

interface MessagesRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly AnthropicMessage[];
  readonly tools: readonly AnthropicTool[];
  readonly tool_choice: { readonly type: 'tool'; readonly name: string };
  readonly max_tokens: number;
  readonly temperature?: number;
}

interface MessagesResponse {
  readonly id?: string;
  readonly model?: string;
  readonly content?: readonly {
    readonly type: string;
    readonly name?: string;
    readonly input?: unknown;
    readonly text?: string;
  }[];
  readonly stop_reason?: string;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

export interface AnthropicAdapterOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxPromptChars?: number;
  readonly maxTokens?: number;
  readonly jsonSchemaOf?: (schema: z.ZodType) => Record<string, unknown>;
}

export class AnthropicAdapter implements LLMAdapter {
  readonly name: string;

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxPromptChars: number;
  private readonly maxTokens: number;
  private readonly jsonSchemaOf: (schema: z.ZodType) => Record<string, unknown>;
  private readonly cfg: LLMProviderConfig;

  constructor(cfg: LLMProviderConfig, options: AnthropicAdapterOptions = {}) {
    if (cfg.provider !== 'anthropic') {
      throw new AnthropicAdapterError(`AnthropicAdapter 不接受 provider=${cfg.provider}`);
    }
    if (cfg.apiKey === undefined) {
      throw new AnthropicAdapterError('AnthropicAdapter 需要 apiKey');
    }
    this.cfg = cfg;
    this.name = `anthropic:${cfg.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPromptChars = options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
    this.maxTokens = options.maxTokens ?? 2048;
    this.jsonSchemaOf =
      options.jsonSchemaOf ??
      ((schema: z.ZodType): Record<string, unknown> =>
        z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>);
  }

  async generate<T = unknown>(request: LLMGenerateRequest): Promise<LLMGenerateResult<T>> {
    if (request.schema === undefined) {
      throw new AnthropicAdapterError('Anthropic 协议需要 schema（tool input_schema）');
    }
    const schema = request.schema as z.ZodType;
    const userContent = JSON.stringify(request.data);
    const truncated = truncate(userContent, this.maxPromptChars);
    const body: MessagesRequest = {
      model: this.cfg.model,
      system: request.system,
      messages: [{ role: 'user', content: truncated }],
      tools: [
        {
          name: ANTHROPIC_TOOL_NAME,
          description: 'Emit the structured advice JSON for luoome advisor agent',
          input_schema: this.jsonSchemaOf(schema),
        },
      ],
      tool_choice: { type: 'tool', name: ANTHROPIC_TOOL_NAME },
      max_tokens: this.maxTokens,
      temperature: 0.2,
    };

    const baseUrl = (this.cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const url = `${baseUrl}/v1/messages`;
    const res = await this.postJson(url, body);
    // 找到 type=tool_use 且 name=emit_advice 的 content 块
    const toolUse = res.content?.find(
      (c) => c.type === 'tool_use' && c.name === ANTHROPIC_TOOL_NAME,
    );
    if (toolUse === undefined || toolUse.input === undefined) {
      throw new AnthropicAdapterError(
        `Anthropic 响应缺 tool_use: stop_reason=${res.stop_reason ?? '?'} content=${JSON.stringify(res.content ?? []).slice(0, 200)}`,
      );
    }
    const outParsed = schema.safeParse(toolUse.input);
    if (!outParsed.success) {
      throw new AnthropicAdapterError(
        `Anthropic tool_use 输入不符合 schema: ${outParsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    const raw = JSON.stringify({ content: res.content, stop_reason: res.stop_reason });
    return { ...(outParsed.data as T), raw };
  }

  private async postJson(url: string, body: MessagesRequest): Promise<MessagesResponse> {
    const apiKey = this.cfg.apiKey;
    if (apiKey === undefined) {
      throw new AnthropicAdapterError('apiKey 不可用（构造时已校验，运行时不可能）');
    }
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new AnthropicAdapterError(
          `HTTP ${res.status} ${res.statusText}: ${errText.slice(0, 200)}`,
          undefined,
          res.status,
        );
      }
      return (await res.json()) as MessagesResponse;
    } catch (error) {
      if (error instanceof AnthropicAdapterError) throw error;
      throw new AnthropicAdapterError(
        `fetch 失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

const truncate = (s: string, maxChars: number): string => {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}...[truncated ${s.length - maxChars} chars]`;
};

export type { LLMAdapter, LLMGenerateRequest, LLMGenerateResult };
