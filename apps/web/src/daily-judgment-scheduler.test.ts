import type { ToolContext, ToolResult } from '@luoome/core';
import { catalogTools } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { type DailyAdviceOutput, dailyAdviceWorkflow } from '@luoome/workflows';
import { describe, expect, it } from 'vitest';

import {
  dueDailyJudgmentTradingDay,
  startDailyJudgmentScheduler,
} from './daily-judgment-scheduler.js';

const okResult = {
  ok: true as const,
  data: {
    advices: [],
    judgment: { action: '今日不动' as const, reason: '无可执行动作', items: [] },
    summary: { total: 0, highConfidence: 0, holdings: 0, candidates: 0, actionable: 0 },
  },
};

const fakeCtx = (clock: () => Date) =>
  ({
    clock,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  }) as unknown as Parameters<typeof startDailyJudgmentScheduler>[0];

/** 2026-11-24 17:30 +08:00（周二交易日）。 */
const SCHEDULED_NOW = new Date('2026-11-24T09:30:00.000Z');
const TRADING_DAY = '2026-11-24';

type ExecutableTool = {
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult<unknown>>;
};

const wrapCatalogTool = (name: string, onCall: () => void): (() => void) => {
  const registry = catalogTools as unknown as Record<string, ExecutableTool>;
  const original = registry[name];
  if (original === undefined) throw new Error(`catalog tool missing: ${name}`);
  registry[name] = {
    ...original,
    execute: async (input, ctx) => {
      onCall();
      return original.execute(input, ctx);
    },
  };
  return () => {
    registry[name] = original;
  };
};

const overrideCatalogTool = (name: string, execute: ExecutableTool['execute']): (() => void) => {
  const registry = catalogTools as unknown as Record<string, ExecutableTool>;
  const original = registry[name];
  if (original === undefined) throw new Error(`catalog tool missing: ${name}`);
  registry[name] = { ...original, execute };
  return () => {
    registry[name] = original;
  };
};

const withCountingLlm = (ctx: ToolContext): { ctx: ToolContext; calls: () => number } => {
  const original = ctx.adapters.llm;
  let calls = 0;
  const llm = {
    name: `counting-${original.name}`,
    generate: async (request: unknown) => {
      calls += 1;
      return original.generate(request as never);
    },
  } as unknown as typeof original;
  return {
    ctx: { ...ctx, adapters: { ...ctx.adapters, llm } },
    calls: () => calls,
  };
};

const runScheduler = async (
  ctx: ToolContext,
  options: Parameters<typeof startDailyJudgmentScheduler>[1] = {},
): Promise<void> => {
  const scheduler = startDailyJudgmentScheduler(ctx, { startImmediately: false, ...options });
  try {
    await scheduler.tick();
  } finally {
    scheduler.stop();
  }
};

describe('dueDailyJudgmentTradingDay', () => {
  it('17:30 后触发，返回交易日 key', () => {
    expect(dueDailyJudgmentTradingDay(new Date('2026-11-12T09:30:00.000Z'))).toBe('2026-11-12');
  });

  it('17:29 尚未到点', () => {
    expect(dueDailyJudgmentTradingDay(new Date('2026-11-12T09:29:00.000Z'))).toBeNull();
  });

  it('周末与节假日不触发', () => {
    expect(dueDailyJudgmentTradingDay(new Date('2026-11-14T09:30:00.000Z'))).toBeNull();
    expect(dueDailyJudgmentTradingDay(new Date('2026-10-01T09:30:00.000Z'))).toBeNull();
  });
});

describe('startDailyJudgmentScheduler', () => {
  it('同一交易日只跑一次', async () => {
    let calls = 0;
    const scheduler = startDailyJudgmentScheduler(
      fakeCtx(() => new Date('2026-11-12T09:35:00.000Z')),
      {
        startImmediately: false,
        run: async () => {
          calls += 1;
          return okResult as unknown as { ok: true; data: DailyAdviceOutput };
        },
      },
    );
    await scheduler.tick();
    await scheduler.tick();
    scheduler.stop();
    expect(calls).toBe(1);
  });

  it('未到点不跑', async () => {
    let calls = 0;
    const scheduler = startDailyJudgmentScheduler(
      fakeCtx(() => new Date('2026-11-12T08:00:00.000Z')),
      {
        startImmediately: false,
        run: async () => {
          calls += 1;
          return okResult as unknown as { ok: true; data: DailyAdviceOutput };
        },
      },
    );
    await scheduler.tick();
    scheduler.stop();
    expect(calls).toBe(0);
  });
});

describe('startDailyJudgmentScheduler 17:30 固定路径', () => {
  it('同一窗口先 daily-stock-briefs 再 daily-advice(briefsOnly)，不调用 analyze_stock', async () => {
    const base = await buildTestContext({ advices: [], clock: () => SCHEDULED_NOW });
    const { ctx } = withCountingLlm(base);
    const order: string[] = [];
    let analyzeCalls = 0;
    const restoreBriefs = wrapCatalogTool('generate_stock_briefs', () =>
      order.push('generate_stock_briefs'),
    );
    const restoreBriefsList = wrapCatalogTool('list_stock_briefs', () =>
      order.push('list_stock_briefs'),
    );
    const restoreAnalyze = wrapCatalogTool('analyze_stock', () => {
      analyzeCalls += 1;
    });
    try {
      await runScheduler(ctx);
    } finally {
      restoreAnalyze();
      restoreBriefsList();
      restoreBriefs();
    }

    expect(order).toEqual(['generate_stock_briefs', 'list_stock_briefs']);
    expect(analyzeCalls).toBe(0);

    const runs = await base.repos.workflowRun.listRecent({ limit: 10 });
    expect(runs).toHaveLength(2);
    const briefsRun = runs.find((run) => run.workflowName === 'daily-stock-briefs');
    const adviceRun = runs.find((run) => run.workflowName === 'daily-advice');
    expect(briefsRun?.mode).toBe('scheduled');
    expect(briefsRun?.status).toBe('succeeded');
    expect(briefsRun?.outputSummary?.llmHttpCalls).toBeGreaterThan(0);
    expect(briefsRun?.outputSummary).toMatchObject({
      coverage: { candidates: expect.any(Number) },
      budget: { limit: { maxHttpCalls: 16 } },
    });
    expect(adviceRun?.mode).toBe('scheduled');
    expect(adviceRun?.status).toBe('succeeded');
    expect(adviceRun?.outputSummary).toMatchObject({ briefsOnly: true, llmHttpCalls: 0 });
    expect(adviceRun?.outputSummary).not.toHaveProperty('tokens');
  });

  it('briefs 失败时不派生 advice，也不自动回退 analyze_stock', async () => {
    const base = await buildTestContext({ advices: [], clock: () => SCHEDULED_NOW });
    const order: string[] = [];
    let analyzeCalls = 0;
    const restoreBriefs = overrideCatalogTool('generate_stock_briefs', async () => {
      order.push('generate_stock_briefs');
      return { ok: false, error: { kind: 'internal', cause: 'briefs fixture failure' } };
    });
    const restoreBriefsList = wrapCatalogTool('list_stock_briefs', () =>
      order.push('list_stock_briefs'),
    );
    const restoreAnalyze = wrapCatalogTool('analyze_stock', () => {
      analyzeCalls += 1;
    });
    try {
      await runScheduler(base);
    } finally {
      restoreAnalyze();
      restoreBriefsList();
      restoreBriefs();
    }

    expect(order).toEqual(['generate_stock_briefs']);
    expect(analyzeCalls).toBe(0);
    const runs = await base.repos.workflowRun.listRecent({ limit: 10 });
    expect(runs.find((run) => run.workflowName === 'daily-stock-briefs')?.status).toBe('failed');
    expect(runs.some((run) => run.workflowName === 'daily-advice')).toBe(false);
  });

  it('同一窗口 LLM 计量只在 briefs：advice(briefsOnly) 增量为 0', async () => {
    const base = await buildTestContext({ advices: [], clock: () => SCHEDULED_NOW });
    const { ctx, calls } = withCountingLlm(base);
    await runScheduler(ctx);

    const briefs = await base.repos.stockBrief.findByDay({
      tradingDate: TRADING_DAY,
      accountId: base.user.defaultAccountId,
    });
    expect(briefs.length).toBeGreaterThan(0);
    expect(briefs.reduce((total, brief) => total + brief.llmHttpCalls, 0)).toBeGreaterThan(0);

    const afterScheduler = calls();
    const advice = await dailyAdviceWorkflow.run(
      { briefsOnly: true },
      { ...ctx, clock: () => SCHEDULED_NOW },
    );
    expect(advice.ok).toBe(true);
    expect(calls()).toBe(afterScheduler);
  });
});

describe('startDailyJudgmentScheduler 删除旧路径', () => {
  it('设置 LUOOME_DAILY_JUDGMENT_LEGACY=true 也仍然只走 briefs → advice', async () => {
    const previous = process.env.LUOOME_DAILY_JUDGMENT_LEGACY;
    process.env.LUOOME_DAILY_JUDGMENT_LEGACY = 'true';
    const ctx = await buildTestContext({ advices: [], clock: () => SCHEDULED_NOW });
    const order: string[] = [];
    let analyzeCalls = 0;
    const restoreBriefs = wrapCatalogTool('generate_stock_briefs', () =>
      order.push('generate_stock_briefs'),
    );
    const restoreBriefsList = wrapCatalogTool('list_stock_briefs', () =>
      order.push('list_stock_briefs'),
    );
    const restoreAnalyze = wrapCatalogTool('analyze_stock', () => {
      analyzeCalls += 1;
    });
    try {
      await runScheduler(ctx);
    } finally {
      restoreAnalyze();
      restoreBriefsList();
      restoreBriefs();
      if (previous === undefined) delete process.env.LUOOME_DAILY_JUDGMENT_LEGACY;
      else process.env.LUOOME_DAILY_JUDGMENT_LEGACY = previous;
    }

    expect(order).toEqual(['generate_stock_briefs', 'list_stock_briefs']);
    expect(analyzeCalls).toBe(0);
  });

  it('并发 tick 不会重叠执行同一交易日', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = startDailyJudgmentScheduler(
      fakeCtx(() => new Date('2026-11-12T09:35:00.000Z')),
      {
        startImmediately: false,
        run: async () => {
          calls += 1;
          await gate;
          return okResult as unknown as { ok: true; data: DailyAdviceOutput };
        },
      },
    );
    const first = scheduler.tick();
    await scheduler.tick();
    release();
    await first;
    scheduler.stop();
    expect(calls).toBe(1);
  });
});
