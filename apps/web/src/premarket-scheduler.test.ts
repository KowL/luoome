import type { ToolContext } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import type { DailyStockBriefsOutput } from '@luoome/workflows';
import { describe, expect, it } from 'vitest';

import { duePremarketTradingDay, startPremarketScheduler } from './premarket-scheduler.js';

const fakeCtx = (clock: () => Date) =>
  ({
    clock,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  }) as unknown as ToolContext;

/** 2026-11-24（周二交易日）08:50 +08:00。 */
const PREMARKET_NOW = new Date('2026-11-24T00:50:00.000Z');
const TRADING_DAY = '2026-11-24';

const okBriefs = (tradingDay: string): { ok: true; data: DailyStockBriefsOutput } => ({
  ok: true,
  data: {
    briefs: {
      tradingDate: tradingDay,
      phase: 'premarket',
      items: [],
      summary: {
        llmHttpCalls: 0,
        tokens: 0,
        llmBriefs: 0,
        ruleOnlyBriefs: 0,
        unavailableBriefs: 0,
        skippedByDigest: 0,
        budgetStopped: 0,
        degraded: false,
      },
      coverage: { holdings: 0, watchlist: 0, signals: 0, candidates: 0 },
      budget: {
        date: tradingDay,
        httpCalls: 0,
        tokens: 0,
        costUsd: 0,
        limit: { maxBriefs: 8, maxHttpCalls: 16, maxTokens: 90_000 },
      },
    },
    coverage: { holdings: 0, watchlist: 0, signals: 0, candidates: 0 },
    budget: {
      date: tradingDay,
      httpCalls: 0,
      tokens: 0,
      costUsd: 0,
      limit: { maxBriefs: 8, maxHttpCalls: 16, maxTokens: 90_000 },
    },
    workflowRunId: 'workflow-daily-stock-briefs-test',
  },
});

const runScheduler = async (
  ctx: ToolContext,
  options: Parameters<typeof startPremarketScheduler>[1] = {},
): Promise<void> => {
  const scheduler = startPremarketScheduler(ctx, { startImmediately: false, ...options });
  try {
    await scheduler.tick();
  } finally {
    scheduler.stop();
  }
};

const countLlm = (ctx: ToolContext): { ctx: ToolContext; calls: () => number } => {
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

describe('duePremarketTradingDay', () => {
  it('交易日 08:45 起触发，08:44 尚未到点', () => {
    // 2026-11-24 08:44 / 08:45 北京 = 00:44 / 00:45 UTC
    expect(duePremarketTradingDay(new Date('2026-11-24T00:44:59.000Z'))).toBeNull();
    expect(duePremarketTradingDay(new Date('2026-11-24T00:45:00.000Z'))).toBe('2026-11-24');
    expect(duePremarketTradingDay(new Date('2026-11-24T01:30:00.000Z'))).toBe('2026-11-24');
  });

  it('周末与节假日即使过了 08:45 也不触发', () => {
    expect(duePremarketTradingDay(new Date('2026-11-14T00:50:00.000Z'))).toBeNull();
    expect(duePremarketTradingDay(new Date('2026-10-01T00:50:00.000Z'))).toBeNull();
  });
});

describe('startPremarketScheduler', () => {
  it('非交易日 tick 不调用 run', async () => {
    let calls = 0;
    const run = async (tradingDay: string) => {
      calls += 1;
      return okBriefs(tradingDay);
    };
    await runScheduler(
      fakeCtx(() => new Date('2026-11-14T00:50:00.000Z')),
      { run },
    );
    await runScheduler(
      fakeCtx(() => new Date('2026-10-01T00:50:00.000Z')),
      { run },
    );
    expect(calls).toBe(0);
  });

  it('未到 08:45 不跑', async () => {
    let calls = 0;
    await runScheduler(
      fakeCtx(() => new Date('2026-11-24T00:44:59.000Z')),
      {
        run: async (tradingDay) => {
          calls += 1;
          return okBriefs(tradingDay);
        },
      },
    );
    expect(calls).toBe(0);
  });

  it('同一交易日第二次 tick 不重复跑', async () => {
    let calls = 0;
    const scheduler = startPremarketScheduler(
      fakeCtx(() => PREMARKET_NOW),
      {
        startImmediately: false,
        run: async (tradingDay) => {
          calls += 1;
          return okBriefs(tradingDay);
        },
      },
    );
    try {
      await scheduler.tick();
      await scheduler.tick();
    } finally {
      scheduler.stop();
    }
    expect(calls).toBe(1);
  });

  it('模拟重启：新实例同日会再跑一次（写库幂等由工作流保证）', async () => {
    const seen: string[] = [];
    const run = async (tradingDay: string) => {
      seen.push(tradingDay);
      return okBriefs(tradingDay);
    };
    await runScheduler(
      fakeCtx(() => PREMARKET_NOW),
      { run },
    );
    await runScheduler(
      fakeCtx(() => PREMARKET_NOW),
      { run },
    );
    expect(seen).toEqual([TRADING_DAY, TRADING_DAY]);
  });
});

describe('startPremarketScheduler 真实盘前批次', () => {
  it('0 次 LLM、写出 premarket 规则观察 brief、advices 不变', async () => {
    const base = await buildTestContext({ advices: [], clock: () => PREMARKET_NOW });
    const before = await base.repos.advice.query({});
    const { ctx, calls } = countLlm(base);

    await runScheduler(ctx);

    expect(calls()).toBe(0);
    expect((await base.repos.advice.query({})).length).toBe(before.length);

    const briefs = await base.repos.stockBrief.findByDay({
      tradingDate: TRADING_DAY,
      accountId: base.user.defaultAccountId,
    });
    expect(briefs.length).toBeGreaterThan(0);
    for (const brief of briefs) {
      expect(brief.phase).toBe('premarket');
      expect(['rule-only', 'unavailable']).toContain(brief.quality);
      expect(brief.llmHttpCalls).toBe(0);
      expect(brief.adviceId).toBeUndefined();
    }

    const runs = await base.repos.workflowRun.listRecent({ limit: 10 });
    const briefsRun = runs.find((run) => run.workflowName === 'daily-stock-briefs');
    expect(briefsRun?.mode).toBe('scheduled');
    expect(briefsRun?.outputSummary).toMatchObject({ llmHttpCalls: 0, tokens: 0 });
  });

  it('同日再跑一次（重启）不新增 advices，premarket brief 仍只有一份', async () => {
    const base = await buildTestContext({ advices: [], clock: () => PREMARKET_NOW });
    const { ctx, calls } = countLlm(base);

    await runScheduler(ctx);
    await runScheduler(ctx);

    expect(calls()).toBe(0);
    expect(await base.repos.advice.query({})).toHaveLength(0);
    const briefs = await base.repos.stockBrief.findByDay({
      tradingDate: TRADING_DAY,
      accountId: base.user.defaultAccountId,
    });
    expect(briefs.every((brief) => brief.phase === 'premarket')).toBe(true);
    expect(new Set(briefs.map((brief) => brief.stockId)).size).toBe(briefs.length);
  });
});
