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

    it('失败 + 重试失败 → 显式抛错（无规则兜底，DSH 改造 §2.4）', async () => {
      const real = new StubAdapter('real-stub');
      real.failMode = 'throw';
      const mgr = new LLMManager({
        adapter: real,
        logger: silentLogger,
      });
      await expect(
        mgr.generate<ParsedAdvice>({
          system: 's',
          schema: TestSchema,
          data: { indicators: { X: { ma5: 10, ma20: 8 } } },
        }),
      ).rejects.toThrow('stub fail');
      expect(real.callCount).toBe(2); // 第一次 + retry
      // retry 时的 system 应包含 "Retry hint"
      expect(real.capturedSystems[1] ?? '').toContain('Retry hint');
    });

    it('无 schema 时第一次失败 → 直接抛错，不重试', async () => {
      const real = new StubAdapter('real-stub');
      real.failMode = 'throw';
      const mgr = new LLMManager({
        adapter: real,
        logger: silentLogger,
      });
      await expect(mgr.generate<ParsedAdvice>({ system: 's', data: {} })).rejects.toThrow(
        'stub fail',
      );
      expect(real.callCount).toBe(1);
    });

    it('重试成功 → 返回重试结果，共调用 2 次', async () => {
      const real = new StubAdapter('real-stub');
      let calls = 0;
      const original = real.generate.bind(real);
      real.generate = async <T>(req: LLMGenerateRequest): Promise<LLMGenerateResult<T>> => {
        calls += 1;
        if (calls === 1) {
          real.capturedSystems.push(req.system);
          throw new Error('stub fail');
        }
        return original<T>(req);
      };
      const mgr = new LLMManager({
        adapter: real,
        logger: silentLogger,
      });
      const out = await mgr.generate<ParsedAdvice>({
        system: 's',
        schema: TestSchema,
        data: {},
      });
      expect(out.decision).toBe('hold');
      expect(calls).toBe(2);
      expect(real.capturedSystems[1] ?? '').toContain('Retry hint');
    });
  });
});
