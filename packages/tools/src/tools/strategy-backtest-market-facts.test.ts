import { createHash } from 'node:crypto';
import {
  type DailyBarRevision,
  EVALUATOR_CODE_IDENTITY_SOURCE,
  STRATEGY_EVALUATOR_CODE_HASH,
  STRATEGY_EVALUATOR_VERSION,
  type StrategyEvaluationSession,
  type StrategyRun,
  stockCode,
  strategyDefinitionHash,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import {
  describeBacktestFactSkips,
  syncBacktestMarketFacts,
} from '../internal/backtest-market-facts.js';
import { buildTestContext } from '../testing/context.js';
import {
  createStrictStrategyBacktestTool,
  executeStrictStrategyBacktestTool,
} from './strategy-backtest.js';

const D0 = new Date('2026-08-12T00:00:00.000Z');
const D1 = new Date('2026-08-13T00:00:00.000Z');
const D2 = new Date('2026-08-14T00:00:00.000Z');
const D3 = new Date('2026-08-17T00:00:00.000Z');
const NOW = new Date('2026-08-17T08:00:00.000Z');
const cutoffOf = (day: Date): Date => new Date(day.getTime() + 16 * 3600 * 1000);
const hex = (seed: string): string => createHash('sha256').update(seed).digest('hex');
const stockIds = ['600519.SH', '000001.SZ', '600036.SH', '000002.SZ', '601398.SH'];
const benchmarkId = '000300.SH';
const definition = {
  schemaVersion: 1 as const,
  metadata: {},
  universe: { coverage: 'CN_A_SHARES_SH_SZ' as const, excludeStockIds: [] as string[] },
  selection: {
    logic: 'all' as const,
    rules: [
      {
        id: 't22-rule',
        name: 'T22 fixture rule',
        when: 'close > 0',
        evidence: ['fixture'],
      },
    ],
  },
  signals: { entry: [], exit: [], risk: [] },
};

const session: StrategyEvaluationSession = {
  id: 't22-evaluation-session',
  strategyId: 't22-strategy',
  strategyVersionId: 't22-strategy-v1',
  from: D1,
  to: D3,
  status: 'complete',
  definitionHash: strategyDefinitionHash(definition),
  createdAt: D1,
  finishedAt: NOW,
};

const revision = (stockId: string, date: Date, open: number, close: number): DailyBarRevision => ({
  stockId,
  date,
  contentHash: hex(`${stockId}:${date.toISOString()}:${open}:${close}`),
  open,
  high: Math.max(open, close) + 0.5,
  low: Math.min(open, close) - 0.5,
  close,
  volume: 1_000,
  source: 'fixture',
  recordedAt: date,
});

const runFor = (id: string, day: Date, selected: readonly string[]): StrategyRun => ({
  id,
  strategyId: session.strategyId,
  strategyVersionId: session.strategyVersionId,
  mode: 'replay',
  coverage: 'CN_A_SHARES_SH_SZ',
  dataAsOf: day,
  startedAt: day,
  finishedAt: new Date(day.getTime() + 3600 * 1000),
  status: 'complete',
  scope: 'evaluation',
  inputSnapshot: {
    schemaVersion: 3,
    strategyVersionId: session.strategyVersionId,
    definitionHash: session.definitionHash,
    evaluatorVersion: STRATEGY_EVALUATOR_VERSION,
    evaluatorCodeIdentity: STRATEGY_EVALUATOR_CODE_HASH,
    codeIdentitySource: EVALUATOR_CODE_IDENTITY_SOURCE,
    scope: 'evaluation',
    universeKind: 'full',
    coverage: 'CN_A_SHARES_SH_SZ',
    stockIds: [...selected],
    stockIdChecksum: hex(selected.join(',')),
    requestedBy: 'replay',
    universeCheckpoint: {
      syncId: `sync-${day.toISOString()}`,
      provider: 'fixture',
      observedAt: day,
      memberChecksum: hex('members'),
    },
    acceptancePolicyVersion: 'strategy-run-acceptance-v1',
    evaluationSessionId: session.id,
    dataCheckpoint: { id: `cp-${day.toISOString()}`, dataAsOf: day, checksum: 'cp' },
  },
  providerStatuses: [],
  summary: {},
  publication: undefined,
});

const seed = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  for (const stockId of [...stockIds, benchmarkId]) {
    const [code, exchange] = stockId.split('.') as [string, 'SH' | 'SZ'];
    await ctx.repos.stock.save({ id: stockId, code: stockCode(code), exchange, name: stockId });
  }
  await ctx.repos.strategy.create({
    id: session.strategyId,
    name: 'T22 fixture',
    description: 'T22 market facts fixture',
    owner: 'user',
    status: 'active',
    currentVersionId: session.strategyVersionId,
    createdAt: D1,
    updatedAt: D1,
  });
  await ctx.repos.strategy.createVersion({
    id: session.strategyVersionId,
    strategyId: session.strategyId,
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: D1,
    createdAt: D1,
  });
  await ctx.repos.strategy.publishVersion(session.strategyId, session.strategyVersionId, D1);
  await ctx.repos.strategyEvaluation.saveSession(session);
  const dayRuns: Record<string, StrategyRun> = {
    [D1.toISOString()]: runFor('run-d1', D1, stockIds),
    [D2.toISOString()]: runFor('run-d2', D2, stockIds),
    [D3.toISOString()]: runFor('run-d3', D3, stockIds),
  };
  for (const day of [D1, D2, D3]) {
    const run = dayRuns[day.toISOString()];
    if (run === undefined) throw new Error('fixture run missing');
    await ctx.repos.strategyRun.commitRun({
      run,
      results: stockIds.map((stockId, index) => ({
        runId: run.id,
        stockId,
        selected: true,
        score: 90 - index,
        rank: index + 1,
        ruleEvaluations: [],
        evidence: [],
        dataAsOf: day,
      })),
      signals: [],
    });
    await ctx.repos.strategyEvaluation.saveDay({
      sessionId: session.id,
      dataAsOf: day,
      runId: run.id,
      universeSyncId: `sync-${day.toISOString()}`,
      dataCheckpointId: `cp-${day.toISOString()}`,
      revisionCutoff: cutoffOf(day),
      vintageStatus: 'available',
      status: 'complete',
      evaluatedCount: stockIds.length,
      selectedCount: stockIds.length,
      signalCount: 0,
      failedCount: 0,
    });
    await ctx.repos.stockUniverse.applySnapshot({
      syncId: `sync-${day.toISOString()}`,
      appliedAt: day,
      snapshot: {
        source: 'fixture',
        coverage: 'CN_A_SHARES_SH_SZ',
        observedAt: day,
        complete: true,
        reportedTotal: stockIds.length,
        entries: stockIds.map((stockId) => {
          const [code, exchange] = stockId.split('.') as [string, 'SH' | 'SZ'];
          return {
            stockId,
            code: stockCode(code),
            exchange,
            name: stockId,
            listingStatus: 'listed' as const,
            stStatus: 'non-st' as const,
            industry: 'fixture',
          };
        }),
      },
    });
  }
  // D0 提供前收盘；D1–D3 提供当日 revision；benchmark 只需执行日。
  const prices: Record<string, [number, number][]> = {
    [D0.toISOString()]: [
      [9.5, 9.5],
      [9.5, 9.5],
      [9.5, 9.5],
      [9.5, 9.5],
      [9.5, 9.5],
      [1000, 1000],
    ],
    [D1.toISOString()]: [
      [10, 10.5],
      [10, 10.5],
      [10, 10.5],
      [10, 10.5],
      [10, 10.5],
      [1000, 1005],
    ],
    [D2.toISOString()]: [
      [11, 11.2],
      [11, 11.2],
      [11, 11.2],
      [11, 11.2],
      [11, 11.2],
      [1005, 1008],
    ],
    [D3.toISOString()]: [
      [12, 11.5],
      [12, 11.5],
      [12, 11.5],
      [12, 11.5],
      [12, 11.5],
      [1009, 1010],
    ],
  };
  for (const [dateKey, rows] of Object.entries(prices)) {
    const date = new Date(dateKey);
    const all = [...stockIds, benchmarkId];
    await ctx.repos.dailyBar.saveRevisions(
      all.map((stockId, index) => {
        const pair = rows[index];
        if (pair === undefined) throw new Error('fixture price missing');
        return revision(stockId, date, pair[0], pair[1]);
      }),
    );
  }
};

const costs = {
  commissionBps: 10,
  minimumCommission: 5,
  sellStampDutyBps: 10,
  buySlippageBps: 0,
  sellSlippageBps: 0,
};

describe('T22 market facts 生产者 + 门禁披露', () => {
  it('PIT 属性齐全时 tradability complete；market_facts 落库；corporate-actions 明确 unavailable', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seed(ctx);
    const result = await createStrictStrategyBacktestTool.execute(
      {
        strategyId: session.strategyId,
        evaluationSessionId: session.id,
        costs,
      },
      ctx,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const run = result.data.run;
    const items = run.gateAudit.items;
    const item = (key: string) => items.find((entry) => entry.key === key);
    expect(item('pit-universe')).toMatchObject({ status: 'complete' });
    expect(item('daily-bar-revisions')).toMatchObject({ status: 'complete' });
    expect(item('tradability')).toMatchObject({ status: 'complete' });
    expect(item('corporate-actions')).toMatchObject({ status: 'unavailable' });
    expect(item('corporate-actions')?.reason).toContain('无分红送转数据源');
    expect(item('corporate-actions')?.reason).toContain('§8');
    expect(item('benchmark')).toMatchObject({ status: 'complete' });
    expect(item('evaluator-code')).toMatchObject({ status: 'complete' });
    // 门禁整体仍是 partial（corporate-actions 缺口），但不阻断执行。
    expect(run.gateAudit.status).toBe('partial');
    expect(run.status).toBe('queued');

    const facts = await ctx.repos.strategyBacktest.listMarketFacts({
      stockIds,
      from: D2,
      to: D3,
    });
    expect(facts).toHaveLength(stockIds.length * 2);
    for (const fact of facts) {
      expect(fact.corporateActionsStatus).toBe('unavailable');
      expect(fact.corporateActions).toEqual([]);
      expect(fact.source).toContain('tradability-rule-v1');
      expect(fact.buyAllowed).toBe(true);
      expect(fact.sellAllowed).toBe(true);
    }
    expect(facts.find((fact) => fact.date.getTime() === D2.getTime())?.recordedAt).toEqual(D2);

    const executed = await executeStrictStrategyBacktestTool.execute(
      { backtestRunId: run.id },
      ctx,
    );
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.data.run.status).toBe('complete');
    expect(executed.data.run.resultAvailability).toBe('complete');
    expect(executed.data.run.metrics?.tradeCount).toBe(15);

    // 同一 spec + 同一输入指纹：重复 create 返回同一 run；重复 execute 幂等。
    const again = await createStrictStrategyBacktestTool.execute(
      { strategyId: session.strategyId, evaluationSessionId: session.id, costs },
      ctx,
    );
    expect(again.ok && again.data.run.id).toBe(run.id);
    const reexecuted = await executeStrictStrategyBacktestTool.execute(
      { backtestRunId: run.id },
      ctx,
    );
    expect(reexecuted.ok && reexecuted.data.run.metrics).toEqual(executed.data.run.metrics);
  });
});

describe('T22 生产者：ST unknown / 涨跌停 / 前收盘缺失', () => {
  const day = D2;
  const prev = D1;
  const seedOne = async (
    ctx: Awaited<ReturnType<typeof buildTestContext>>,
    options: { readonly stStatus: 'st' | 'non-st' | 'unknown'; readonly open: number },
  ) => {
    const stockId = '600519.SH';
    await ctx.repos.stock.save({
      id: stockId,
      code: stockCode('600519'),
      exchange: 'SH',
      name: '贵州茅台',
    });
    await ctx.repos.stockUniverse.applySnapshot({
      syncId: 'sync-t22-unit',
      appliedAt: day,
      snapshot: {
        source: 'fixture',
        coverage: 'CN_A_SHARES_SH_SZ',
        observedAt: day,
        complete: true,
        reportedTotal: 1,
        entries: [
          {
            stockId,
            code: stockCode('600519'),
            exchange: 'SH',
            name: '贵州茅台',
            listingStatus: 'listed',
            stStatus: options.stStatus,
          },
        ],
      },
    });
    await ctx.repos.dailyBar.saveRevisions([
      revision(stockId, prev, 10, 10),
      revision(stockId, day, options.open, options.open),
    ]);
    return stockId;
  };

  it('ST unknown 时不写事实并给出可读原因（门禁可解释 partial）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const stockId = await seedOne(ctx, { stStatus: 'unknown', open: 10 });
    const report = await syncBacktestMarketFacts(
      {
        stockIds: [stockId],
        days: [{ dataAsOf: day, universeSyncId: 'sync-t22-unit', revisionCutoff: cutoffOf(day) }],
      },
      ctx,
    );
    expect(report.written).toBe(0);
    expect(report.skipped).toEqual([
      { stockId, date: day.toISOString(), reason: 'st-status-unknown' },
    ]);
    expect(describeBacktestFactSkips(report)).toContain('缺 ST 状态');
  });

  it('开盘触及涨停时 buyRestriction=limit-up；ST 股按 5% 幅度', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const stockId = await seedOne(ctx, { stStatus: 'st', open: 10.5 });
    const report = await syncBacktestMarketFacts(
      {
        stockIds: [stockId],
        days: [{ dataAsOf: day, universeSyncId: 'sync-t22-unit', revisionCutoff: cutoffOf(day) }],
      },
      ctx,
    );
    expect(report.written).toBe(1);
    const facts = await ctx.repos.strategyBacktest.listMarketFacts({
      stockIds: [stockId],
      from: day,
      to: day,
    });
    expect(facts[0]).toMatchObject({
      buyAllowed: false,
      buyRestriction: 'limit-up',
      sellAllowed: true,
      corporateActionsStatus: 'unavailable',
    });
    // ST 5%：前收 10 → 涨停 10.50；开盘正好 10.50。
    expect(facts[0]?.rawOpen).toBe(10.5);
  });

  it('缺前收盘价时不写事实', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const stockId = '600519.SH';
    await ctx.repos.stock.save({
      id: stockId,
      code: stockCode('600519'),
      exchange: 'SH',
      name: '贵州茅台',
    });
    await ctx.repos.stockUniverse.applySnapshot({
      syncId: 'sync-t22-unit',
      appliedAt: day,
      snapshot: {
        source: 'fixture',
        coverage: 'CN_A_SHARES_SH_SZ',
        observedAt: day,
        complete: true,
        reportedTotal: 1,
        entries: [
          {
            stockId,
            code: stockCode('600519'),
            exchange: 'SH',
            name: '贵州茅台',
            listingStatus: 'listed',
            stStatus: 'non-st',
          },
        ],
      },
    });
    await ctx.repos.dailyBar.saveRevisions([revision(stockId, day, 10, 10)]);
    const report = await syncBacktestMarketFacts(
      {
        stockIds: [stockId],
        days: [{ dataAsOf: day, universeSyncId: 'sync-t22-unit', revisionCutoff: cutoffOf(day) }],
      },
      ctx,
    );
    expect(report.skipped).toEqual([
      { stockId, date: day.toISOString(), reason: 'missing-prev-close' },
    ]);
  });
});
