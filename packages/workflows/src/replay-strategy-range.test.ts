import { createHash } from 'node:crypto';
import {
  money,
  type Strategy,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { replayStrategyRangeWorkflow } from './replay-strategy-range.js';

const FROM = new Date('2026-07-27T00:00:00.000Z');
const TO = new Date('2026-07-29T00:00:00.000Z');
const STOCK_ID = '600519.SH';

const seedReplayStrategy = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  now: Date,
): Promise<void> => {
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: {
      logic: 'all',
      rules: [
        {
          id: 'positive-price',
          name: '价格有效',
          when: 'quote.close > 0',
          evidence: ['价格有效'],
        },
      ],
    },
    scoring: {
      method: 'weighted-sum',
      components: [{ ruleId: 'positive-price', score: '50', weight: 1 }],
    },
    signals: {
      entry: [
        {
          id: 'entry',
          name: '历史信号',
          when: 'quote.close > 0',
          score: '60',
          direction: 'bullish',
          evidence: ['历史输入'],
        },
      ],
      exit: [],
      risk: [],
    },
  };
  const version: StrategyVersion = {
    id: 'replay-strategy-v1',
    strategyId: 'replay-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  };
  const strategy: Strategy = {
    id: 'replay-strategy',
    name: 'Replay 测试策略',
    description: '验证历史 revision cutoff',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.repos.strategy.create(strategy);
  await ctx.repos.strategy.createVersion(version);
};

const revisionFor = (close: number, date: Date, recordedAt: Date) => {
  const input = {
    stockId: STOCK_ID,
    date,
    open: money(close),
    high: money(close + 1),
    low: money(close - 1),
    close: money(close),
    volume: 1_000_000,
    source: 'replay-fixture',
  };
  return {
    ...input,
    contentHash: createHash('sha256')
      .update(
        JSON.stringify({
          open: input.open,
          high: input.high,
          low: input.low,
          close: input.close,
          volume: input.volume,
          source: input.source,
        }),
      )
      .digest('hex'),
    recordedAt,
  };
};

const replayContext = async (options: { readonly now?: Date; readonly observedAt?: Date } = {}) => {
  const now = options.now ?? new Date('2026-08-12T09:00:00.000Z');
  const ctx = await buildTestContext({ clock: () => now });
  await seedTestStockUniverse(ctx, { limit: 1, observedAt: options.observedAt ?? now });
  await seedReplayStrategy(ctx, now);
  return ctx;
};

const saveTradingDayRevision = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  dataAsOf: Date,
  recordedAt: Date,
): Promise<void> => {
  await ctx.repos.dailyBar.saveRevisions([revisionFor(10, dataAsOf, recordedAt)]);
};

describe('replay-strategy-range workflow', () => {
  it('拒绝 from 晚于 to 的区间', async () => {
    const ctx = await buildTestContext();
    const result = await replayStrategyRangeWorkflow.run(
      { strategyId: 'strategy-a', from: TO, to: FROM },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });

  it('逐交易日 replay 并聚合当日运行事实', async () => {
    const ctx = await replayContext();
    for (const dataAsOf of [FROM, new Date('2026-07-28T00:00:00.000Z'), TO]) {
      await saveTradingDayRevision(ctx, dataAsOf, new Date(dataAsOf.getTime() - 86_400_000));
    }

    const result = await replayStrategyRangeWorkflow.run(
      {
        strategyId: 'replay-strategy',
        versionId: 'replay-strategy-v1',
        from: FROM,
        to: TO,
        stockIds: [STOCK_ID],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('complete');
    expect(result.data.days.map((day) => day.status)).toEqual(['complete', 'complete', 'complete']);
    expect(result.data.summary).toEqual({
      tradingDays: 3,
      completedDays: 3,
      failedDays: 0,
      evaluatedCount: 3,
      selectedCount: 3,
      signalCount: 3,
      failedCount: 0,
    });
    expect(result.data.days.every((day) => day.runId !== undefined)).toBe(true);
  });

  it('不使用交易日内 revision cutoff 之后才记录的修订', async () => {
    const asOf = new Date('2026-08-10T00:00:00.000Z');
    const ctx = await replayContext();
    // 修订在 asOf 之后才落库：PIT cutoff 读不到，不允许用未来修订伪装历史输入。
    await saveTradingDayRevision(ctx, asOf, new Date('2026-08-11T00:00:00.000Z'));

    const result = await replayStrategyRangeWorkflow.run(
      {
        strategyId: 'replay-strategy',
        versionId: 'replay-strategy-v1',
        from: asOf,
        to: asOf,
        stockIds: [STOCK_ID],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // revision cutoff 之后才落库的修订不可见：该交易日无 PIT 日线，
    // 股票仍进入评估但不会被选中或产生信号（不使用未来修订伪造历史输入）。
    expect(result.data.days[0]).toMatchObject({
      status: 'complete',
      evaluatedCount: 1,
      selectedCount: 0,
      signalCount: 0,
      failedCount: 0,
    });
    expect(result.data.status).toBe('complete');
  });

  it('PIT universe 使用交易日结束边界内的快照', async () => {
    const asOf = new Date('2026-08-10T00:00:00.000Z');
    // 快照发生在 asOf 当天盘中（UTC 15:00），交易日结束边界内仍应可见。
    const ctx = await replayContext({ observedAt: new Date('2026-08-10T15:00:00.000Z') });
    await saveTradingDayRevision(ctx, asOf, new Date('2026-08-09T00:00:00.000Z'));

    const result = await replayStrategyRangeWorkflow.run(
      {
        strategyId: 'replay-strategy',
        versionId: 'replay-strategy-v1',
        from: asOf,
        to: asOf,
        stockIds: [STOCK_ID],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.days[0]).toMatchObject({
      status: 'complete',
      evaluatedCount: 1,
      selectedCount: 1,
    });
  });

  it('persist=false 时不落库运行事实也不返回 runId', async () => {
    const asOf = new Date('2026-08-10T00:00:00.000Z');
    const ctx = await replayContext();
    await saveTradingDayRevision(ctx, asOf, new Date('2026-08-09T00:00:00.000Z'));

    const result = await replayStrategyRangeWorkflow.run(
      {
        strategyId: 'replay-strategy',
        versionId: 'replay-strategy-v1',
        from: asOf,
        to: asOf,
        stockIds: [STOCK_ID],
        persist: false,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.days[0]?.runId).toBeUndefined();
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: 'replay-strategy' })).toEqual([]);
  });
});
