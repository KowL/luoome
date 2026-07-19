import type { LLMGenerateRequest, Logger } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LLMManager } from './manager.js';
import type { LLMAdapter, LLMGenerateResult } from './types.js';

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
  // 跟踪 system 内容以验证 retry hint 是否附加
  capturedSystems: string[] = [];
  constructor(name: string) {
    this.name = name;
  }
  async generate<T>(_req: LLMGenerateRequest): Promise<LLMGenerateResult<T>> {
    this.callCount += 1;
    this.capturedSystems.push(_req.system);
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
  describe('provider=mock', () => {
    it('直接走 mock；name=mock', async () => {
      const stub = new StubAdapter('mock-stub');
      const mgr = new LLMManager({
        config: { provider: 'mock', model: 'mock-v0' },
        mockFactory: () => stub,
        logger: silentLogger,
      });
      const out = await mgr.generate<ParsedAdvice>({
        system: 's',
        schema: TestSchema,
        data: {},
      });
      expect(mgr.name).toBe('mock-stub'); // mockFactory 返回的 adapter name
      expect(out.decision).toBe('hold');
      expect(stub.callCount).toBe(1);
    });

    it('mock 抛错时不触发 fallback 协议（避免无限循环）', async () => {
      const stub = new StubAdapter('mock-stub');
      stub.failMode = 'throw';
      const mgr = new LLMManager({
        config: { provider: 'mock', model: 'mock-v0' },
        mockFactory: () => stub,
        logger: silentLogger,
      });
      await expect(
        mgr.generate<ParsedAdvice>({ system: 's', schema: TestSchema, data: {} }),
      ).rejects.toThrow();
      expect(stub.callCount).toBe(1);
    });
  });

  describe('provider=openai-compatible + realFactory 注入 stub', () => {
    it('成功一次 → 直接返回，callCount=1', async () => {
      const real = new StubAdapter('real-stub');
      const mgr = new LLMManager({
        config: { provider: 'openai-compatible', apiKey: 'sk', baseUrl: 'https://x', model: 'm' },
        mockFactory: () => new StubAdapter('unused-mock'),
        realFactory: () => real,
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

    it('失败 + 重试失败 → 走规则 fallback（不抛异常）', async () => {
      const real = new StubAdapter('real-stub');
      real.failMode = 'throw';
      const mgr = new LLMManager({
        config: { provider: 'openai-compatible', apiKey: 'sk', baseUrl: 'https://x', model: 'm' },
        mockFactory: () => new StubAdapter('unused-mock'),
        realFactory: () => real,
        logger: silentLogger,
      });
      const out = await mgr.generate<ParsedAdvice>({
        system: 's',
        schema: TestSchema,
        data: { indicators: { X: { ma5: 10, ma20: 8 } } },
      });
      // fallback: MA5 > MA20 → watch @ 30
      expect(out.decision).toBe('watch');
      expect(out.confidence).toBe(30);
      expect(out.reasoning.evidence.some((e) => e.includes('LLM 推理失败'))).toBe(true);
      expect(real.callCount).toBe(2); // 第一次 + retry
      // retry 时的 system 应包含 "Retry hint"
      expect(real.capturedSystems[1] ?? '').toContain('Retry hint');
    });

    it('MA5 ≤ MA20 → fallback 走 hold @ 20', async () => {
      const real = new StubAdapter('real-stub');
      real.failMode = 'throw';
      const mgr = new LLMManager({
        config: { provider: 'openai-compatible', apiKey: 'sk', baseUrl: 'https://x', model: 'm' },
        mockFactory: () => new StubAdapter('unused'),
        realFactory: () => real,
        logger: silentLogger,
      });
      const out = await mgr.generate<ParsedAdvice>({
        system: 's',
        schema: TestSchema,
        data: { indicators: { X: { ma5: 8, ma20: 10 } } },
      });
      expect(out.decision).toBe('hold');
      expect(out.confidence).toBe(20);
    });

    it('indicators 缺失 → fallback hold @ 20 + 默认 evidence', async () => {
      const real = new StubAdapter('real-stub');
      real.failMode = 'throw';
      const mgr = new LLMManager({
        config: { provider: 'openai-compatible', apiKey: 'sk', baseUrl: 'https://x', model: 'm' },
        mockFactory: () => new StubAdapter('unused'),
        realFactory: () => real,
        logger: silentLogger,
      });
      const out = await mgr.generate<ParsedAdvice>({
        system: 's',
        schema: TestSchema,
        data: { foo: 'bar' }, // 无 indicators
      });
      expect(out.decision).toBe('hold');
      expect(out.confidence).toBe(20);
      expect(out.reasoning.evidence.some((e) => e.includes('MA5 / MA20 缺失'))).toBe(true);
    });
  });

  describe('realFactory 抛错时回退 mock', () => {
    it('realFactory throw → mockFactory 接管', async () => {
      const mockStub = new StubAdapter('mock-takeover');
      const mgr = new LLMManager({
        config: { provider: 'openai-compatible', apiKey: 'sk', baseUrl: 'https://x', model: 'm' },
        mockFactory: () => mockStub,
        realFactory: () => {
          throw new Error('real adapter broken');
        },
        logger: silentLogger,
      });
      // 此时 mgr.inner === mock，generate 走 mock 路径（不会触发 fallback）
      const out = await mgr.generate<ParsedAdvice>({
        system: 's',
        schema: TestSchema,
        data: {},
      });
      expect(mgr.name).toBe('mock-takeover');
      expect(out.decision).toBe('hold');
    });
  });
});
