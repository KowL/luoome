import {
  AdviceDecisionSchema,
  AdviceHorizonSchema,
  AdviceReasoningSchema,
  money,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { type FakeAnalysisOutput, FakeLLMAdapter } from './fake-llm.js';
import { TEST_HOLDINGS, TEST_STOCK_BASE_PRICES } from './fixtures.js';

/**
 * 模拟 tools 层的 AdviceLLMSchema（ARCHITECTURE §6.3）。
 * 注：adapters 包未声明 zod 依赖（package.json 不可改），zod 由 Bun isolated
 * install 只链接到 core；因此这里用 core 导出的 zod schema 组合一个
 * safeParse 校验器——对 adapter 而言仍是「传入 schema → safeParse → 校验」。
 */
interface SafeParseSchema {
  safeParse(input: unknown): { success: boolean; data?: unknown; error?: unknown };
}

const AdviceLLMSchema: SafeParseSchema = {
  safeParse(input: unknown) {
    const record =
      typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : null;
    if (!record) return { success: false, error: 'not an object' };
    if (!AdviceDecisionSchema.safeParse(record.decision).success) {
      return { success: false, error: 'invalid decision' };
    }
    const confidence = record.confidence;
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 100) {
      return { success: false, error: 'invalid confidence' };
    }
    if (!AdviceHorizonSchema.safeParse(record.horizon).success) {
      return { success: false, error: 'invalid horizon' };
    }
    if (!AdviceReasoningSchema.safeParse(record.reasoning).success) {
      return { success: false, error: 'invalid reasoning' };
    }
    const risks = record.risks;
    if (!Array.isArray(risks) || !risks.every((r) => typeof r === 'string')) {
      return { success: false, error: 'invalid risks' };
    }
    return { success: true, data: input };
  },
};

const makeAdapter = () => new FakeLLMAdapter();

describe('FakeLLMAdapter.generate / analyze_stock', () => {
  it('输出通过传入 zod schema parse，且带 raw 文本', async () => {
    const llm = makeAdapter();
    const result = await llm.generate<FakeAnalysisOutput>({
      system: '你是 analyze_stock 投顾分析助手',
      schema: AdviceLLMSchema,
      data: { stockId: '002594.SZ' },
    });
    expect(typeof result.raw).toBe('string');
    expect(result.raw.length).toBeGreaterThan(0);
    const { raw: _raw, ...parsed } = result;
    expect(AdviceLLMSchema.safeParse(parsed).success).toBe(true);
  });

  it('deterministic：同一输入同一输出', async () => {
    const llm = makeAdapter();
    const req = {
      system: 'analyze_stock',
      schema: AdviceLLMSchema,
      data: { stockId: '00700.HK' },
    } as const;
    const a = await llm.generate<FakeAnalysisOutput>(req);
    const b = await llm.generate<FakeAnalysisOutput>(req);
    expect(b).toEqual(a);
  });

  it('不同 stockId 的 hash 输入参与决策（输出结构仍合法）', async () => {
    const llm = makeAdapter();
    for (const stockId of ['600519.SH', 'AAPL.US', 'NVDA.US', '00941.HK']) {
      const result = await llm.generate<FakeAnalysisOutput>({
        system: 'analyze_stock',
        schema: AdviceLLMSchema,
        data: { stockId },
      });
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(100);
      expect(result.reasoning.premise).toContain(stockId);
    }
  });
});

describe('FakeLLMAdapter.generate / analyze_position', () => {
  it('识别 analyze_position 标识，输出过 schema', async () => {
    const llm = makeAdapter();
    const holding = TEST_HOLDINGS.find((h) => h.stockId === '002594.SZ');
    expect(holding).toBeDefined();
    const result = await llm.generate<FakeAnalysisOutput>({
      system: '你是 analyze_position 持仓诊断助手',
      schema: AdviceLLMSchema,
      data: {
        holding,
        quote: { stockId: '002594.SZ', close: TEST_STOCK_BASE_PRICES['002594.SZ'] },
      },
    });
    const { raw: _raw, ...parsed } = result;
    expect(AdviceLLMSchema.safeParse(parsed).success).toBe(true);
  });

  it('持仓上下文生效：浮盈 ≥15% → sell 且 confidence ≥70', async () => {
    const llm = makeAdapter();
    const result = await llm.generate<FakeAnalysisOutput>({
      system: 'analyze_position',
      schema: AdviceLLMSchema,
      data: {
        holding: { stockId: '002594.SZ', avgCost: money(100), quantity: 1000 },
        quote: { stockId: '002594.SZ', close: money(130) },
      },
    });
    expect(result.decision).toBe('sell');
    expect(result.confidence).toBeGreaterThanOrEqual(70);
    expect(result.reasoning.premise).toContain('止盈');
  });

  it('持仓上下文生效：浮亏 ≥10% → hold', async () => {
    const llm = makeAdapter();
    const result = await llm.generate<FakeAnalysisOutput>({
      system: 'analyze_position',
      schema: AdviceLLMSchema,
      data: {
        holding: { stockId: '600519.SH', avgCost: money(100), quantity: 100 },
        quote: { stockId: '600519.SH', close: money(85) },
      },
    });
    expect(result.decision).toBe('hold');
    expect(result.reasoning.premise).toContain('浮亏');
  });
});

describe('FakeLLMAdapter.generate / fallback', () => {
  it('schema parse 失败时返回稳定 fallback', async () => {
    const llm = makeAdapter();
    const impossibleSchema: SafeParseSchema = {
      safeParse: () => ({ success: false, error: 'always fails' }),
    };
    const req = {
      system: 'analyze_stock',
      schema: impossibleSchema,
      data: { stockId: '002594.SZ' },
    } as const;
    const a = await llm.generate<FakeAnalysisOutput>(req);
    const b = await llm.generate<FakeAnalysisOutput>(req);
    expect(a.decision).toBe('watch');
    expect(a.confidence).toBe(50);
    expect(b).toEqual(a); // fallback 同样 deterministic
    expect(typeof a.raw).toBe('string');
  });

  it('不传 schema 时原样返回候选输出', async () => {
    const llm = makeAdapter();
    const result = await llm.generate<FakeAnalysisOutput>({
      system: 'analyze_stock',
      data: { stockId: 'AAPL.US' },
    });
    expect(result.decision).toBeDefined();
    expect(typeof result.raw).toBe('string');
  });
});
