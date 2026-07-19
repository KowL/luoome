import type { LLMGenerateRequest, Logger } from '@luoome/core';
import {
  AdviceDecisionSchema,
  AdviceHorizonSchema,
  AdviceReasoningSchema,
  type LLMProviderConfig,
  parseLlmProviderConfigFromEnv,
  STANDARD_DISCLAIMERS,
} from '@luoome/core';
import { z } from 'zod';
import { AnthropicAdapter, AnthropicAdapterError } from './anthropic.js';
import { OpenAICompatibleAdapter, OpenAICompatibleAdapterError } from './openai-compatible.js';
import type { LLMAdapter, LLMGenerateResult } from './types.js';

/**
 * LLM 适配器编排（v0.2 起）。
 *
 * 职责：
 * 1. 从 env 解析 LLMProviderConfig（provider=mock 时直接返回 MockLLMAdapter）。
 * 2. 选 OpenAICompatibleAdapter / AnthropicAdapter；mock fallback 用于：
 *    - 真实 adapter 抛 schema 不匹配错误时，第二次重试仍失败 → 走规则 fallback；
 *    - apiKey 缺失（构造期抛）→ 直接 mock。
 * 3. 实现 fallback 协议（plan-v0.2-v0.3 §2.3）：
 *    - 第一次 schema parse 失败 → 自动重试一次，prompt 加「上一轮未符合 schema」提示；
 *    - 仍失败 → 走 fallbackAdvice(data)，在 reasoning.evidence 标「LLM 推理失败，使用规则 fallback」；
 *    - 永不抛异常（永远返回 LLMGenerateResult）。
 *
 * 注：fallback 不返回 raw；advice.basedOn.llmReasoning 拿不到 raw 时省略。
 */

const FALLBACK_NOTE = 'LLM 推理失败，使用规则 fallback（v0.2 LLMManager）';

export interface LLMManagerOptions {
  /** 默认 parseLlmProviderConfigFromEnv(process.env)；测试可注入。 */
  readonly config?: LLMProviderConfig;
  /** 构造 mock adapter 的工厂；测试可注入自定义 mock。 */
  readonly mockFactory?: () => LLMAdapter;
  readonly realFactory?: (cfg: LLMProviderConfig, fetchImpl?: typeof fetch) => LLMAdapter;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
}

/** Fallback 输出 schema（与 AdviceLLMSchema 对齐）。 */
const fallbackAdvice = (data: unknown): AdviceLLMOutput => {
  // 极简规则：MA5 > MA20 → watch（30）；否则 hold（20）
  const indicators = readIndicators(data);
  const ma5 = indicators.ma5;
  const ma20 = indicators.ma20;
  let decision: 'watch' | 'hold' = 'hold';
  let confidence = 20;
  const evidence: string[] = [FALLBACK_NOTE];
  if (
    typeof ma5 === 'number' &&
    typeof ma20 === 'number' &&
    Number.isFinite(ma5) &&
    Number.isFinite(ma20)
  ) {
    if (ma5 > ma20) {
      decision = 'watch';
      confidence = 30;
      evidence.push(`fallback 规则: MA5(${ma5}) > MA20(${ma20}) → watch`);
    } else {
      evidence.push(`fallback 规则: MA5(${ma5}) ≤ MA20(${ma20}) → hold`);
    }
  } else {
    evidence.push('fallback 规则: MA5 / MA20 缺失 → hold (默认)');
  }
  return {
    decision,
    confidence,
    horizon: 'short',
    reasoning: {
      premise: 'LLM 推理不可用，基于规则的保守判断',
      evidence,
      counterEvidence: ['规则 fallback 不考虑基本面 / 新闻 / 战法信号，结果仅供参考'],
    },
    risks: ['规则 fallback 信心度低，不应据此下单'],
  };
};

const readIndicators = (data: unknown): Record<string, number> => {
  if (typeof data !== 'object' || data === null) return {};
  const d = data as { indicators?: unknown };
  const indicators = d.indicators;
  if (typeof indicators !== 'object' || indicators === null) return {};
  // indicators 是 Record<string, TechnicalIndicators>；取首项
  const map = indicators as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    const v = map[key];
    if (typeof v === 'object' && v !== null) {
      return v as Record<string, number>;
    }
  }
  return {};
};

// 与 packages/tools/src/internal/build-advice.ts 的 AdviceLLMSchema 对齐
// （避免循环 import，此处重写一份最小 schema；fallback 不需要完整字段）
const AdviceLLMSchemaForFallback = z.object({
  decision: AdviceDecisionSchema,
  confidence: z.number().min(0).max(100),
  horizon: AdviceHorizonSchema,
  reasoning: AdviceReasoningSchema,
  risks: z.array(z.string()),
});

type AdviceLLMOutput = z.infer<typeof AdviceLLMSchemaForFallback>;

export class LLMManager implements LLMAdapter {
  readonly name: string;
  private readonly inner: LLMAdapter;
  private readonly mock: LLMAdapter;
  private readonly logger: Logger;

  constructor(options: LLMManagerOptions) {
    this.logger = options.logger;
    const cfg = options.config ?? parseLlmProviderConfigFromEnv(process.env);
    this.mock = options.mockFactory ? options.mockFactory() : defaultMockFactory();
    if (cfg.provider === 'mock') {
      this.inner = this.mock;
      this.name = this.mock.name; // 反映 mockFactory 的实际 adapter 名
      return;
    }
    try {
      this.inner = options.realFactory
        ? options.realFactory(cfg, options.fetchImpl)
        : this.buildProvider(cfg, options.fetchImpl);
      this.name = this.inner.name;
    } catch (error) {
      this.logger.error('llm-manager: 构造 provider 失败，回退到 mock', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.inner = this.mock;
      this.name = this.mock.name;
    }
  }

  async generate<T = unknown>(request: LLMGenerateRequest): Promise<LLMGenerateResult<T>> {
    if (this.inner === this.mock) {
      // 已经在 mock 模式：直接返回 mock 结果，不走 fallback 协议（避免无限包装）
      return (await this.mock.generate<T>(request)) as LLMGenerateResult<T>;
    }

    // 第一次调用
    let firstError: unknown;
    try {
      return await this.inner.generate<T>(request);
    } catch (error) {
      firstError = error;
      this.logger.warn('llm-manager: 第一次 LLM 调用失败，准备重试', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 重试一次：system 提示追加「上一轮未符合 schema，请重试」
    if (request.schema !== undefined) {
      try {
        const retryRequest: LLMGenerateRequest = {
          system: `${request.system}\n\n[Retry hint] 上一轮你的输出未能通过 JSON schema 校验（${describeError(firstError)}）。请重新生成严格符合 schema 的 JSON。`,
          schema: request.schema,
          data: request.data,
        };
        return await this.inner.generate<T>(retryRequest);
      } catch (retryError) {
        this.logger.warn('llm-manager: 重试仍失败，走规则 fallback', {
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
      }
    }

    // 规则 fallback：用 mock 的 fixture 形状 + fallbackAdvice 标记
    const fallbackData = this.buildFallbackResult<T>(request);
    this.logger.error('llm-manager: 走规则 fallback', { decision: this.preview(fallbackData) });
    return fallbackData;
  }

  /** 把 fallback 包装成 LLMGenerateResult<T>（无 raw）。 */
  private buildFallbackResult<T>(request: LLMGenerateRequest): LLMGenerateResult<T> {
    const parsed = fallbackAdvice(request.data);
    const validated = AdviceLLMSchemaForFallback.parse(parsed) as unknown as T;
    return { ...validated } as LLMGenerateResult<T>;
  }

  private preview<T>(result: LLMGenerateResult<T>): string {
    const r = result as unknown as Partial<AdviceLLMOutput>;
    return `${r.decision ?? '?'}@${r.confidence ?? '?'}`;
  }

  private buildProvider(cfg: LLMProviderConfig, fetchImpl?: typeof fetch): LLMAdapter {
    if (cfg.provider === 'openai-compatible') {
      return new OpenAICompatibleAdapter(cfg, fetchImpl !== undefined ? { fetchImpl } : {});
    }
    if (cfg.provider === 'anthropic') {
      return new AnthropicAdapter(cfg, fetchImpl !== undefined ? { fetchImpl } : {});
    }
    throw new Error(`unknown provider: ${cfg.provider}`);
  }
}

const describeError = (e: unknown): string => {
  if (e instanceof OpenAICompatibleAdapterError) return `OpenAI: ${e.message}`;
  if (e instanceof AnthropicAdapterError) return `Anthropic: ${e.message}`;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
};

import { MockLLMAdapter } from './mock.js';

const defaultMockFactory = (): LLMAdapter => new MockLLMAdapter();

export type { LLMAdapter, LLMGenerateRequest, LLMGenerateResult };
export { AdviceDecisionSchema, AdviceHorizonSchema, AdviceReasoningSchema, STANDARD_DISCLAIMERS };
