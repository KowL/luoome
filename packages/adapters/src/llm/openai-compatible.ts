import type { LLMGenerateRequest, LLMProviderConfig } from '@luoome/core';
import { z } from 'zod';
import type { LLMAdapter, LLMGenerateResult } from './types.js';

/**
 * OpenAI 兼容 chat completions 适配器（v0.2 起）。
 *
 * 覆盖：OpenAI / DeepSeek / Kimi / Moonshot / Zhipu（5 家都用相同协议 + json_schema response_format）。
 *
 * 设计要点：
 * - system + data 拆为 system message + user message（data 序列化为 JSON 字符串）。
 * - response_format.json_schema：把 zod schema 转为 JSON Schema，强制 LLM 输出符合；
 *   v0.2 用 z.toJSONSchema（与 toolRegistry 同一口径，保证行为一致）。
 * - 不在 adapter 内做重试（fallback 协议由 Manager 处理）。
 */

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PROMPT_CHARS = 16_000; // 与 LLM_MAX_PROMPT_TOKENS 4000 对应的字符粗估（4 char ≈ 1 token）

export class OpenAICompatibleAdapterError extends Error {
  override readonly name = 'OpenAICompatibleAdapterError';
  constructor(
    message: string,
    override readonly cause?: unknown,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

interface ChatCompletionsRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly response_format: {
    readonly type: 'json_schema';
    readonly json_schema: {
      readonly name: string;
      readonly schema: Record<string, unknown>;
      readonly strict?: boolean;
    };
  };
  readonly temperature?: number;
}

interface ChatCompletionsResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: readonly {
    readonly message?: { readonly role?: string; readonly content?: string };
    readonly finish_reason?: string;
  }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

export interface OpenAICompatibleAdapterOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxPromptChars?: number;
  /** 测试用：覆盖 schema→JSON Schema 转换。 */
  readonly jsonSchemaOf?: (schema: z.ZodType) => Record<string, unknown>;
}

export class OpenAICompatibleAdapter implements LLMAdapter {
  readonly name: string;

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxPromptChars: number;
  private readonly jsonSchemaOf: (schema: z.ZodType) => Record<string, unknown>;
  private readonly cfg: LLMProviderConfig;

  constructor(cfg: LLMProviderConfig, options: OpenAICompatibleAdapterOptions = {}) {
    if (cfg.provider !== 'openai-compatible') {
      throw new OpenAICompatibleAdapterError(
        `OpenAICompatibleAdapter 不接受 provider=${cfg.provider}`,
      );
    }
    if (cfg.apiKey === undefined) {
      throw new OpenAICompatibleAdapterError('OpenAICompatibleAdapter 需要 apiKey');
    }
    this.cfg = cfg;
    this.name = `openai-compatible:${cfg.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPromptChars = options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
    this.jsonSchemaOf =
      options.jsonSchemaOf ??
      ((schema: z.ZodType): Record<string, unknown> =>
        z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>);
  }

  async generate<T = unknown>(request: LLMGenerateRequest): Promise<LLMGenerateResult<T>> {
    if (request.schema === undefined) {
      throw new OpenAICompatibleAdapterError(
        'OpenAI 兼容协议需要 schema（response_format.json_schema）',
      );
    }
    const schema = request.schema as z.ZodType;
    const userContent = JSON.stringify(request.data);
    const truncated = truncate(userContent, this.maxPromptChars);
    const body: ChatCompletionsRequest = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: truncated },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'luoome_advice',
          schema: this.jsonSchemaOf(schema),
          strict: true,
        },
      },
      temperature: 0.2,
    };

    const baseUrl = (this.cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const url = `${baseUrl}/chat/completions`;
    const res = await this.postJson(url, body);
    const text = res.choices?.[0]?.message?.content;
    if (text === undefined || text === '') {
      throw new OpenAICompatibleAdapterError(
        `OpenAI 响应无 content: ${JSON.stringify(res).slice(0, 200)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new OpenAICompatibleAdapterError(
        `OpenAI 响应 JSON 解析失败: ${text.slice(0, 200)}`,
        error,
      );
    }
    const outParsed = schema.safeParse(parsed);
    if (!outParsed.success) {
      throw new OpenAICompatibleAdapterError(
        `OpenAI 输出不符合 schema: ${outParsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    return { ...(outParsed.data as T), raw: text };
  }

  private async postJson(
    url: string,
    body: ChatCompletionsRequest,
  ): Promise<ChatCompletionsResponse> {
    const apiKey = this.cfg.apiKey;
    if (apiKey === undefined) {
      throw new OpenAICompatibleAdapterError('apiKey 不可用（构造时已校验，运行时不可能）');
    }
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new OpenAICompatibleAdapterError(
          `HTTP ${res.status} ${res.statusText}: ${errText.slice(0, 200)}`,
          undefined,
          res.status,
        );
      }
      return (await res.json()) as ChatCompletionsResponse;
    } catch (error) {
      if (error instanceof OpenAICompatibleAdapterError) throw error;
      throw new OpenAICompatibleAdapterError(
        `fetch 失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

/** 字符串截断（不切碎 JSON）。超过 maxChars 时尾部追加截断标记。 */
const truncate = (s: string, maxChars: number): string => {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}...[truncated ${s.length - maxChars} chars]`;
};

// 显式导出类型供 manager 用
export type { LLMAdapter, LLMGenerateRequest, LLMGenerateResult };
