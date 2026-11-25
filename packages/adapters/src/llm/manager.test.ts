import type { LLMGenerateRequest, Logger } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LLMManager } from './manager.js';
import {
  type LLMAdapter,
  type LLMAdapterLimits,
  type LLMGenerateResult,
  LLMOutputBudgetError,
  LLMTimeoutError,
} from './types.js';

type ParsedAdvice = z.infer<typeof TestSchema>;
const TestSchema = z.object({
  decision: z.enum(['buy', 'sell', 'hold', 'watch', 'avoid']),
  confidence: z.number().min(0).max(100),
  horizon: z.enum(['intraday', 'short', 'medium', 'long']),
  reasoning: z.object({
    premise: z.string().min(1),
    evidence: z.array(z.string()),
    counterEvidence: z.array(z.string()),
  }),
  risks: z.array(z.string()),
});

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 可控 stub：failMode + 返回 fake data。 */
class StubAdapter implements LLMAdapter {
  readonly name: string;
  callCount = 0;
  failMode: 'ok' | 'throw' = 'ok';
  failMessage = 'stub fail';
  /** 只抛一次的特定错误（用于验证重试预算放大）。 */
  failOnce: Error | undefined = undefined;
  limits: LLMAdapterLimits = { maxOutputTokens: 2_048, timeoutMs: 60_000 };
  // 跟踪 system / 重试请求以验证 retry hint 与预算放大
  capturedSystems: string[] = [];
  requests: LLMGenerateRequest[] = [];
  constructor(name: string) {
    this.name = name;
  }
  async generate<T>(_req: LLMGenerateRequest): Promise<LLMGenerateResult<T>> {
    this.callCount += 1;
    this.requests.push(_req);
    this.capturedSystems.push(_req.system);
    if (this.failOnce !== undefined) {
      const error = this.failOnce;
      this.failOnce = undefined;
      throw error;
    }
    if (this.failMode === 'throw') throw new Error(this.failMessage);
    const fake = {
      decision: 'hold' as const,
      confidence: 60,
      horizon: 'short' as const,
      reasoning: { premise: 'p', evidence: ['e'], counterEvidence: ['c'] },
      risks: ['r'],
    };
    return { ...(fake as unknown as T), raw: JSON.stringify(fake) };
  }
}

describe('llm/manager', () => {
  describe('adapter 注入', () => {
    it('成功一次 → 直接返回，callCount=1', async () => {
      const real = new StubAdapter('real-stub');
      const mgr = new LLMManager({
        adapter: real,
        logger: silentLogger,
      });
      const out = await mgr.generate<ParsedAdvice>({
        system: 's',
        schema: TestSchema,
        data: {},
      });
      expect(mgr.name).toBe('real-stub');
      expect(out.decision).toBe('hold');
      expect(real.callCount).toBe(1);
    });

    it('第一次失败、重试成功 → 返回重试结果并带 retry hint', async () => {
      const real = new StubAdapter('real-stub');
      real.failOnce = new Error('first fail');
      const mgr = new LLMManager({ adapter: real, logger: silentLogger });

      const out = await mgr.generate<ParsedAdvice>({
        system: 's',
        schema: TestSchema,
        data: {},
      });

      expect(out.decision).toBe('hold');
      expect(real.callCount).toBe(2);
      expect(real.capturedSystems[1] ?? '').toContain('Retry hint');
      expect(real.capturedSystems[1] ?? '').toContain('first fail');
    });

    it('重试仍失败 → 抛错，不构造任何业务输出', async () => {
      const real = new StubAdapter('real-stub');
      real.failMode = 'throw';
      const mgr = new LLMManager({ adapter: real, logger: silentLogger });

      await expect(
        mgr.generate<ParsedAdvice>({
          system: 's',
          schema: TestSchema,
          data: { indicators: { X: { ma5: 10, ma20: 8 } } },
        }),
      ).rejects.toThrow('stub fail');
      expect(real.callCount).toBe(2);
    });

    it('policy.managerRetry=false 时不重试，HTTP 次数≤1', async () => {
      const real = new StubAdapter('real-stub');
      real.failMode = 'throw';
      const mgr = new LLMManager({ adapter: real, logger: silentLogger });

      await expect(
        mgr.generate<ParsedAdvice>({
          system: 's',
          schema: TestSchema,
          data: {},
          policy: { managerRetry: false, providerRetries: 0 },
        }),
      ).rejects.toThrow('stub fail');
      expect(real.callCount).toBe(1);
    });

    it('policy.providerRetries 随 retry 请求保留', async () => {
      const real = new StubAdapter('real-stub');
      real.failOnce = new Error('first fail');
      const mgr = new LLMManager({ adapter: real, logger: silentLogger });

      await mgr.generate<ParsedAdvice>({
        system: 's',
        schema: TestSchema,
        data: {},
        policy: { providerRetries: 0 },
      });

      expect(real.requests[1]?.policy).toEqual({ providerRetries: 0 });
    });

    it('超时失败 → 重试时放大 timeoutMs', async () => {
      const real = new StubAdapter('real-stub');
      real.failOnce = new LLMTimeoutError('模型调用超时（timeoutMs=60000）');
      const mgr = new LLMManager({ adapter: real, logger: silentLogger });

      await mgr.generate<ParsedAdvice>({
        system: 's',
        schema: TestSchema,
        data: { indicators: { X: { ma5: 10, ma20: 8 } } },
      });

      expect(real.callCount).toBe(2);
      expect(real.requests[1]?.timeoutMs).toBe(120_000);
      expect(real.requests[1]?.maxOutputTokens).toBeUndefined();
    });

    it('缺 schema 的请求不重试，直接抛第一次错误', async () => {
      const real = new StubAdapter('real-stub');
      real.failMode = 'throw';
      const mgr = new LLMManager({ adapter: real, logger: silentLogger });

      await expect(mgr.generate({ system: 's', data: {} })).rejects.toThrow('stub fail');
      expect(real.callCount).toBe(1);
    });

    it('输出预算耗尽 → 重试时放大 maxOutputTokens 并带回可诊断错误', async () => {
      const real = new StubAdapter('real-stub');
      real.failOnce = new LLMOutputBudgetError('模型未生成可用内容 (finishReason=length)');
      const mgr = new LLMManager({ adapter: real, logger: silentLogger });

      const out = await mgr.generate<ParsedAdvice>({
        system: 's',
        schema: TestSchema,
        data: { indicators: { X: { ma5: 10, ma20: 8 } } },
      });

      expect(out.decision).toBe('hold');
      expect(real.callCount).toBe(2);
      expect(real.requests[0]?.maxOutputTokens).toBeUndefined();
      expect(real.requests[1]?.maxOutputTokens).toBe(4_096);
      expect(real.capturedSystems[1] ?? '').toContain('输出预算可能被推理耗尽');
      expect(real.capturedSystems[1] ?? '').toContain('finishReason=length');
    });
  });
});
