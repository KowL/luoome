import {
  type Advice,
  dateInShanghai,
  money,
  STANDARD_DISCLAIMERS,
  type StockBrief,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { catalogTools } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import {
  dailyAdviceWorkflow,
  dailyJudgmentDisplay,
  HIGH_CONFIDENCE_THRESHOLD,
} from './daily-advice.js';

/** 2026-11-24 17:30 +08:00（周二交易日）。 */
const FIXED_NOW = new Date('2026-11-24T09:30:00.000Z');
const TRADING_DATE = dateInShanghai(FIXED_NOW);

const makeAdvice = (
  id: string,
  stockId: string,
  decision: Advice['decision'],
  confidence: number,
  createdAt: Date,
): Advice => ({
  id,
  subjectKind: 'stock',
  subjectId: stockId,
  decision,
  confidence,
  horizon: 'short',
  ...(decision === 'buy' || decision === 'sell'
    ? { entryPriceLow: money(100), entryPriceHigh: money(102) }
    : {}),
  reasoning: {
    premise: `测试观察 ${id}`,
    evidence: ['close=105.8'],
    counterEvidence: ['若收盘跌破 100 则本条判断作废'],
  },
  risks: ['可能回调'],
  disclaimers: [...STANDARD_DISCLAIMERS],
  sourceTool: 'analyze_stock',
  basedOn: { dataAsOf: createdAt },
  validFrom: createdAt,
  validUntil: new Date(createdAt.getTime() + 3 * 86_400_000),
  createdAt,
});

const seedBrief = async (
  ctx: ToolContext,
  input: {
    readonly id: string;
    readonly stockId: string;
    readonly quality: StockBrief['quality'];
    readonly decision: StockBrief['decision'];
    readonly confidence?: number;
    readonly phase?: StockBrief['phase'];
    readonly tradingDate?: string;
    readonly adviceId?: string;
  },
): Promise<void> => {
  const now = ctx.clock();
  await ctx.repos.stockBrief.upsert({
    id: input.id,
    tradingDate: input.tradingDate ?? TRADING_DATE,
    phase: input.phase ?? 'post-market',
    accountId: ctx.user.defaultAccountId,
    stockId: input.stockId,
    source: 'scheduled',
    decision: input.decision,
    confidence: input.confidence ?? 50,
    horizon: 'short',
    ...(input.adviceId === undefined ? {} : { adviceId: input.adviceId }),
    quality: input.quality,
    factDigest: `digest-${input.id}`,
    factsAsOf: now,
    missing: [],
    dataSources: ['test'],
    llmHttpCalls: input.quality === 'ai' ? 1 : 0,
    llmPromptTokens: 0,
    llmCompletionTokens: 0,
    llmReasoningTokens: 0,
    llmCostUsd: 0,
    validUntil: new Date(now.getTime() + 86_400_000),
    createdAt: now,
    updatedAt: now,
  });
};

const withCountingLlm = (ctx: ToolContext): { ctx: ToolContext; calls: () => number } => {
  let calls = 0;
  const wrapped = {
    ...ctx,
    adapters: {
      ...ctx.adapters,
      llm: {
        name: 'briefs-only-llm',
        generate: async () => {
          calls += 1;
          throw new Error('daily-advice 不应调用 LLM');
        },
      },
    },
  } as ToolContext;
  return { ctx: wrapped, calls: () => calls };
};

type ExecutableTool = {
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult<unknown>>;
};

const catalogRegistry = catalogTools as unknown as Record<string, ExecutableTool>;

const wrapCatalogTool = (name: string, onCall: () => void): (() => void) => {
  const original = catalogRegistry[name];
  if (original === undefined) throw new Error(`catalog tool missing: ${name}`);
  catalogRegistry[name] = {
    ...original,
    execute: async (input, ctx) => {
      onCall();
      return original.execute(input, ctx);
    },
  };
  return () => {
    catalogRegistry[name] = original;
  };
};

const overrideCatalogTool = (name: string, execute: ExecutableTool['execute']): (() => void) => {
  const original = catalogRegistry[name];
  if (original === undefined) throw new Error(`catalog tool missing: ${name}`);
  catalogRegistry[name] = { ...original, execute };
  return () => {
    catalogRegistry[name] = original;
  };
};

/** 旧路径的两个生成入口（逐只分析 / 批量生成）在 daily-advice 里必须一次都不出现。 */
const countGenerationCalls = (): {
  readonly calls: () => { analyze: number; generate: number };
  readonly restore: () => void;
} => {
  let analyze = 0;
  let generate = 0;
  const restoreAnalyze = wrapCatalogTool('analyze_stock', () => {
    analyze += 1;
  });
  const restoreGenerate = wrapCatalogTool('generate_stock_briefs', () => {
    generate += 1;
  });
  return {
    calls: () => ({ analyze, generate }),
    restore: () => {
      restoreGenerate();
      restoreAnalyze();
    },
  };
};

describe('daily-advice 展示层文案', () => {
  it('今日不动 / 今日可动只改给用户看的标签，枚举值不变', () => {
    expect(dailyJudgmentDisplay('今日不动', 0)).toBe('今日无新信号');
    expect(dailyJudgmentDisplay('今日可动', 2)).toBe('今日有 2 个信号');
  });
});

describe('daily-advice 入口边界：只消费当日 brief', () => {
  it('briefsOnly=false 直接 invalid_input，不进入任何生成路径', async () => {
    const base = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const { ctx, calls } = withCountingLlm(base);
    const generation = countGenerationCalls();
    try {
      const result = await dailyAdviceWorkflow.run({ briefsOnly: false }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('invalid_input');
    } finally {
      generation.restore();
    }
    expect(generation.calls()).toEqual({ analyze: 0, generate: 0 });
    expect(calls()).toBe(0);
  });

  it('manual + 当日无 brief：返回可操作错误，不调用分析 / 生成 / LLM', async () => {
    const base = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const { ctx, calls } = withCountingLlm(base);
    const generation = countGenerationCalls();
    try {
      const result = await dailyAdviceWorkflow.run({}, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === 'invalid_input') {
        expect(result.error.message).toContain('daily-stock-briefs');
        expect(result.error.message).toContain(TRADING_DATE);
      } else {
        throw new Error(`期望 invalid_input，实际 ${JSON.stringify(result)}`);
      }
    } finally {
      generation.restore();
    }
    expect(generation.calls()).toEqual({ analyze: 0, generate: 0 });
    expect(calls()).toBe(0);
  });

  it('前一日 brief 不算当日：manual 仍返回可操作错误', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const now = ctx.clock();
    await ctx.repos.advice.save(makeAdvice('yesterday-buy', '000858.SZ', 'buy', 88, now));
    await seedBrief(ctx, {
      id: 'yesterday-brief',
      stockId: '000858.SZ',
      quality: 'ai',
      decision: 'buy',
      confidence: 88,
      tradingDate: '2026-11-23',
      adviceId: 'yesterday-buy',
    });

    const result = await dailyAdviceWorkflow.run({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('scheduled 但未跑过 briefs + 当日无 brief：不静默出今日不动，返回可操作错误', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const result = await dailyAdviceWorkflow.run({ mode: 'scheduled' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('调度已跑过 briefs + 当日为空：今日不动（partial 语义），不报错也不生成', async () => {
    const base = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const { ctx, calls } = withCountingLlm(base);
    const generation = countGenerationCalls();
    let result: Awaited<ReturnType<typeof dailyAdviceWorkflow.run>>;
    try {
      result = await dailyAdviceWorkflow.run({ mode: 'scheduled', briefsAttempted: true }, ctx);
    } finally {
      generation.restore();
    }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advices).toHaveLength(0);
    expect(result.data.judgment.action).toBe('今日不动');
    expect(result.data.judgment.items).toHaveLength(0);
    expect(result.data.judgment.reason).toContain('尚无个股观察记录');
    expect(result.data.summary).toMatchObject({
      total: 0,
      actionable: 0,
      quality: { ai: 0, ruleOnly: 0, partial: 0, unavailable: 0 },
    });
    expect(generation.calls()).toEqual({ analyze: 0, generate: 0 });
    expect(calls()).toBe(0);

    const runs = await base.repos.workflowRun.listRecent({ limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      workflowName: 'daily-advice',
      mode: 'scheduled',
      status: 'succeeded',
      outputSummary: { briefsOnly: true, llmHttpCalls: 0 },
    });
  });

  it('brief 列表不可用：无论是否跑过 briefs 都透传错误，不伪装成今日不动', async () => {
    const manualCtx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const scheduledCtx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const restore = overrideCatalogTool('list_stock_briefs', async () => ({
      ok: false,
      error: { kind: 'internal', cause: 'briefs fixture failure' },
    }));
    try {
      const manual = await dailyAdviceWorkflow.run({}, manualCtx);
      expect(manual).toEqual({
        ok: false,
        error: { kind: 'internal', cause: 'briefs fixture failure' },
      });

      const scheduled = await dailyAdviceWorkflow.run(
        { mode: 'scheduled', briefsAttempted: true },
        scheduledCtx,
      );
      expect(scheduled).toEqual({
        ok: false,
        error: { kind: 'internal', cause: 'briefs fixture failure' },
      });
    } finally {
      restore();
    }
  });
});

describe('daily-advice workflow', () => {
  it('混合质量：只把 ai buy/sell 放进 judgment，规则观察不计信号，仍结算', async () => {
    const base = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const { ctx, calls } = withCountingLlm(base);
    const now = ctx.clock();
    await ctx.repos.advice.save(makeAdvice('daily-buy', '002594.SZ', 'buy', 80, now));
    await ctx.repos.advice.save(makeAdvice('daily-hold', '600519.SH', 'hold', 60, now));
    await ctx.repos.advice.save(makeAdvice('daily-sell', '300750.SZ', 'sell', 75, now));
    await seedBrief(ctx, {
      id: 'brief-buy',
      stockId: '002594.SZ',
      quality: 'ai',
      decision: 'buy',
      confidence: 80,
      adviceId: 'daily-buy',
    });
    // 同日盘前规则观察应被盘后 AI 行覆盖，不重复计入。
    await seedBrief(ctx, {
      id: 'brief-buy-premarket',
      stockId: '002594.SZ',
      quality: 'rule-only',
      decision: 'hold',
      confidence: 20,
      phase: 'premarket',
    });
    await seedBrief(ctx, {
      id: 'brief-hold',
      stockId: '600519.SH',
      quality: 'ai',
      decision: 'hold',
      confidence: 60,
      adviceId: 'daily-hold',
    });
    await seedBrief(ctx, {
      id: 'brief-sell',
      stockId: '300750.SZ',
      quality: 'ai',
      decision: 'sell',
      confidence: 75,
      adviceId: 'daily-sell',
    });
    await seedBrief(ctx, {
      id: 'brief-rule',
      stockId: '600036.SH',
      quality: 'rule-only',
      decision: 'watch',
      confidence: 20,
    });
    await seedBrief(ctx, {
      id: 'brief-unavailable',
      stockId: '000858.SZ',
      quality: 'unavailable',
      decision: 'hold',
      confidence: 0,
    });

    let settleCalls = 0;
    const restoreSettle = wrapCatalogTool('settle_advices', () => {
      settleCalls += 1;
    });
    const generation = countGenerationCalls();
    let result: Awaited<ReturnType<typeof dailyAdviceWorkflow.run>>;
    try {
      result = await dailyAdviceWorkflow.run({ briefsOnly: true }, ctx);
    } finally {
      generation.restore();
      restoreSettle();
    }

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls()).toBe(0);
    expect(generation.calls()).toEqual({ analyze: 0, generate: 0 });
    expect(settleCalls).toBe(1);
    expect(result.data.advices.map((advice) => advice.id)).toEqual([
      'daily-buy',
      'daily-sell',
      'daily-hold',
    ]);
    expect(result.data.judgment.action).toBe('今日可动');
    expect(result.data.judgment.items.map((item) => item.stockId)).toEqual([
      '002594.SZ',
      '300750.SZ',
    ]);
    expect(result.data.judgment.reason).toContain('2 个信号');
    expect(result.data.summary).toMatchObject({
      total: 3,
      highConfidence: 2,
      actionable: 2,
      candidates: 1,
      quality: { ai: 3, ruleOnly: 1, partial: 0, unavailable: 1 },
    });
    expect(
      result.data.advices.filter((advice) => advice.confidence >= HIGH_CONFIDENCE_THRESHOLD),
    ).toHaveLength(result.data.summary.highConfidence);
    for (const advice of result.data.advices) {
      // Advice 必带反证、风险、免责声明与有效期，不能只给结论。
      expect(advice.reasoning.counterEvidence.length).toBeGreaterThan(0);
      expect(advice.risks.length).toBeGreaterThan(0);
      expect(advice.disclaimers).toEqual([...STANDARD_DISCLAIMERS]);
      expect(advice.validUntil.getTime()).toBeGreaterThan(advice.validFrom.getTime());
    }
  });

  it('仅有规则观察 / unavailable：不进入今日有信号，reason 可解释', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    await seedBrief(ctx, {
      id: 'only-rule',
      stockId: '600036.SH',
      quality: 'rule-only',
      decision: 'hold',
      confidence: 20,
    });
    await seedBrief(ctx, {
      id: 'only-unavailable',
      stockId: '000858.SZ',
      quality: 'unavailable',
      decision: 'hold',
      confidence: 0,
    });

    const result = await dailyAdviceWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.judgment.action).toBe('今日不动');
    expect(result.data.judgment.items).toHaveLength(0);
    expect(result.data.judgment.reason).toContain('均为规则观察或数据不可用');
    expect(result.data.summary).toMatchObject({
      total: 0,
      actionable: 0,
      quality: { ai: 0, ruleOnly: 1, partial: 0, unavailable: 1 },
    });
  });

  it('只有 AI hold/watch：action 仍为今日不动，reason 说明无信号', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const now = ctx.clock();
    await ctx.repos.advice.save(makeAdvice('only-hold', '600519.SH', 'hold', 60, now));
    await seedBrief(ctx, {
      id: 'only-hold-brief',
      stockId: '600519.SH',
      quality: 'ai',
      decision: 'hold',
      confidence: 60,
      adviceId: 'only-hold',
    });

    const result = await dailyAdviceWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advices).toHaveLength(1);
    expect(result.data.judgment.action).toBe('今日不动');
    expect(result.data.judgment.items).toHaveLength(0);
    expect(result.data.judgment.reason).toContain('未出现偏多/偏空信号');
    expect(result.data.summary.actionable).toBe(0);
    expect(result.data.summary.quality.ai).toBe(1);
  });

  it('brief 引用的 advice 已不存在：跳过 advice 但保留质量计数', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    await seedBrief(ctx, {
      id: 'missing-advice-brief',
      stockId: '000858.SZ',
      quality: 'ai',
      decision: 'buy',
      confidence: 90,
      adviceId: 'no-such-advice',
    });

    const result = await dailyAdviceWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advices).toHaveLength(0);
    expect(result.data.judgment.action).toBe('今日不动');
    expect(result.data.summary).toMatchObject({
      total: 0,
      candidates: 1,
      quality: { ai: 1, ruleOnly: 0, partial: 0, unavailable: 0 },
    });
  });

  it('同日多 phase 每票只取一条：盘后优先于盘中', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const now = ctx.clock();
    await ctx.repos.advice.save(makeAdvice('post-buy', '000858.SZ', 'buy', 80, now));
    await ctx.repos.advice.save(makeAdvice('intraday-sell', '000858.SZ', 'sell', 70, now));
    await seedBrief(ctx, {
      id: 'post-brief',
      stockId: '000858.SZ',
      quality: 'ai',
      decision: 'buy',
      confidence: 80,
      adviceId: 'post-buy',
    });
    await seedBrief(ctx, {
      id: 'intraday-brief',
      stockId: '000858.SZ',
      quality: 'ai',
      decision: 'sell',
      confidence: 70,
      phase: 'intraday',
      adviceId: 'intraday-sell',
    });

    const result = await dailyAdviceWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advices.map((advice) => advice.id)).toEqual(['post-buy']);
    expect(result.data.judgment.items).toEqual([
      {
        stockId: '000858.SZ',
        name: expect.any(String),
        decision: 'buy',
        confidence: 80,
        horizon: 'short',
      },
    ]);
    expect(result.data.summary.quality.ai).toBe(1);
  });

  it('scheduled 运行写 workflow_runs 审计：briefsOnly=true 且 LLM 增量为 0', async () => {
    const base = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const now = base.clock();
    await base.repos.advice.save(makeAdvice('audit-buy', '000858.SZ', 'buy', 90, now));
    await seedBrief(base, {
      id: 'audit-brief',
      stockId: '000858.SZ',
      quality: 'ai',
      decision: 'buy',
      confidence: 90,
      adviceId: 'audit-buy',
    });

    const result = await dailyAdviceWorkflow.run({ mode: 'scheduled' }, base);
    expect(result.ok).toBe(true);
    const runs = await base.repos.workflowRun.listRecent({ limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      workflowName: 'daily-advice',
      mode: 'scheduled',
      status: 'succeeded',
      outputSummary: {
        briefsOnly: true,
        judgment: '今日可动',
        total: 1,
        actionable: 1,
        llmHttpCalls: 0,
      },
    });
  });

  it('manual 运行不落 workflow_runs 审计', async () => {
    const base = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    await seedBrief(base, {
      id: 'manual-rule',
      stockId: '600036.SH',
      quality: 'rule-only',
      decision: 'hold',
      confidence: 20,
    });

    const result = await dailyAdviceWorkflow.run({}, base);
    expect(result.ok).toBe(true);
    expect(await base.repos.workflowRun.listRecent({ limit: 10 })).toHaveLength(0);
  });

  it('错误路径：accountId 非 uuid → invalid_input（run 不 throw）', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const result = await dailyAdviceWorkflow.run({ accountId: 'not-a-uuid' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('错误路径：accountId 类型错误 → invalid_input', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const result = await dailyAdviceWorkflow.run({ accountId: 123 }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('错误路径：账户不存在 → not_found 短路', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const result = await dailyAdviceWorkflow.run(
      { accountId: '00000000-0000-4000-8000-000000000000' },
      ctx,
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Account', id: '00000000-0000-4000-8000-000000000000' },
    });
  });
});
