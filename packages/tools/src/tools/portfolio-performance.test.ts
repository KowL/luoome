import { type DailyBar, type DateRange, money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  auditPortfolioPerformanceSnapshotsTool,
  createPortfolioCashFlowTool,
  createPortfolioCorporateActionTool,
  getAccountPerformanceTool,
  listPortfolioPerformanceSnapshotsTool,
} from './portfolio-performance.js';

describe('portfolio performance tools', () => {
  it('generates ledger fact ids instead of accepting caller-controlled ids', async () => {
    const ctx = await buildTestContext();
    const accountId = ctx.user.defaultAccountId;
    const flow = await createPortfolioCashFlowTool.execute(
      {
        id: 'caller-flow-id',
        accountId,
        occurredAt: new Date('2026-07-02T00:00:00.000Z'),
        kind: 'deposit',
        amount: 100,
        currency: 'CNY',
      },
      ctx,
    );
    const action = await createPortfolioCorporateActionTool.execute(
      {
        id: 'caller-action-id',
        accountId,
        stockId: '600519.SH',
        occurredAt: new Date('2026-07-02T00:00:00.000Z'),
        kind: 'split',
        ratio: 2,
      },
      ctx,
    );

    expect(flow.ok).toBe(true);
    expect(action.ok).toBe(true);
    if (!flow.ok || !action.ok) return;
    expect(flow.data.flow.id).toMatch(/^cash-flow-/);
    expect(flow.data.flow.id).not.toBe('caller-flow-id');
    expect(action.data.action.id).toMatch(/^corporate-action-/);
    expect(action.data.action.id).not.toBe('caller-action-id');
    expect(await ctx.repos.portfolioCashFlow.findById('caller-flow-id')).toBeNull();
    expect(await ctx.repos.portfolioCorporateAction.findById('caller-action-id')).toBeNull();
  });

  it('records a real account cash flow and calculates performance from daily bars', async () => {
    const ctx = await buildTestContext();
    const accountId = ctx.user.defaultAccountId;
    const created = await createPortfolioCashFlowTool.execute(
      {
        accountId,
        occurredAt: new Date('2026-07-02T00:00:00.000Z'),
        kind: 'deposit',
        amount: 5_000,
        currency: 'CNY',
      },
      ctx,
    );
    expect(created.ok).toBe(true);

    const result = await getAccountPerformanceTool.execute(
      {
        accountId,
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-03T00:00:00.000Z'),
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.accountId).toBe(accountId);
    expect(result.data.valuation.some((day) => day.externalCashFlow === 5_000)).toBe(true);
    expect(result.data.warnings).toContain('benchmark 日线不可用，未填充替代值');
  });

  it('rejects a corporate action for an unknown stock before writing', async () => {
    const ctx = await buildTestContext();
    const result = await createPortfolioCorporateActionTool.execute(
      {
        accountId: ctx.user.defaultAccountId,
        stockId: 'missing-stock',
        occurredAt: new Date('2026-07-02T00:00:00.000Z'),
        kind: 'split',
        ratio: 2,
      },
      ctx,
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Stock', id: 'missing-stock' },
    });
  });

  it('persists an auditable snapshot and reuses the same input fingerprint', async () => {
    const base = await buildTestContext();
    let fetchCount = 0;
    const ctx = {
      ...base,
      portfolioBenchmark: { stockId: '000300.SH', name: '沪深300' },
      adapters: {
        ...base.adapters,
        market: {
          ...base.adapters.market,
          fetchDailyBars: async (
            ...args: Parameters<typeof base.adapters.market.fetchDailyBars>
          ) => {
            fetchCount += 1;
            return base.adapters.market.fetchDailyBars(...args);
          },
        },
      },
    };
    const input = {
      accountId: base.user.defaultAccountId,
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-03T00:00:00.000Z'),
    };
    const first = await getAccountPerformanceTool.execute(input, ctx);
    const second = await getAccountPerformanceTool.execute(input, ctx);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.audit).toMatchObject({
      inputFingerprint: expect.any(String),
      cacheStatus: 'created',
      calculationDurationMs: expect.any(Number),
      inputFacts: { priceSeries: expect.any(Number), dailyBars: expect.any(Number) },
    });
    expect(second.data.audit).toMatchObject({
      snapshotId: first.data.audit?.snapshotId,
      inputFingerprint: first.data.audit?.inputFingerprint,
      calculatedAt: first.data.audit?.calculatedAt,
      cacheStatus: 'reused',
    });
    expect(first.data.benchmarkStockId).toBe('000300.SH');
    expect(
      await ctx.repos.portfolioPerformanceSnapshot.listByAccount(input.accountId),
    ).toHaveLength(1);
    expect(fetchCount).toBeGreaterThan(0);
  });

  it('输入账本事实变化时创建新快照并保留旧快照追溯', async () => {
    const ctx = await buildTestContext();
    const accountId = ctx.user.defaultAccountId;
    const input = {
      accountId,
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-03T00:00:00.000Z'),
    };
    const first = await getAccountPerformanceTool.execute(input, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await createPortfolioCashFlowTool.execute(
      {
        accountId,
        occurredAt: new Date('2026-07-02T00:00:00.000Z'),
        kind: 'fee',
        amount: 12,
        currency: 'CNY',
      },
      ctx,
    );
    const second = await getAccountPerformanceTool.execute(input, ctx);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.audit?.snapshotId).not.toBe(first.data.audit?.snapshotId);
    expect(second.data.audit?.inputFingerprint).not.toBe(first.data.audit?.inputFingerprint);
    const snapshots = await ctx.repos.portfolioPerformanceSnapshot.listByAccount(accountId);
    expect(snapshots).toHaveLength(2);
    expect(
      await ctx.repos.portfolioPerformanceSnapshot.findById(first.data.audit?.snapshotId ?? ''),
    ).not.toBeNull();
  });

  it('以有界并发抓取大账户价格序列并记录性能预算事实', async () => {
    const base = await buildTestContext();
    let active = 0;
    let maxActive = 0;
    const ctx = {
      ...base,
      portfolioBenchmark: { stockId: '000300.SH', name: '沪深300' },
      adapters: {
        ...base.adapters,
        market: {
          ...base.adapters.market,
          fetchDailyBars: async (
            ...args: Parameters<typeof base.adapters.market.fetchDailyBars>
          ) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            try {
              return await base.adapters.market.fetchDailyBars(...args);
            } finally {
              active -= 1;
            }
          },
        },
      },
    };
    const result = await getAccountPerformanceTool.execute(
      {
        accountId: base.user.defaultAccountId,
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-03T00:00:00.000Z'),
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(8);
    expect(result.data.audit?.inputFacts?.priceSeries).toBeGreaterThan(1);
    expect(result.data.audit?.calculationDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('审计快照区间覆盖并暴露缺失交易日，不重新请求行情', async () => {
    const ctx = await buildTestContext();
    const accountId = ctx.user.defaultAccountId;
    const performance = await getAccountPerformanceTool.execute(
      {
        accountId,
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-03T00:00:00.000Z'),
      },
      ctx,
    );
    expect(performance.ok).toBe(true);

    const complete = await auditPortfolioPerformanceSnapshotsTool.execute(
      {
        accountId,
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-03T00:00:00.000Z'),
      },
      ctx,
    );
    expect(complete).toMatchObject({
      ok: true,
      data: {
        audit: {
          expectedTradingDays: 3,
          observedTradingDays: 3,
          completeness: 'complete',
          missingDates: [],
        },
      },
    });

    const partial = await auditPortfolioPerformanceSnapshotsTool.execute(
      {
        accountId,
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-06T00:00:00.000Z'),
      },
      ctx,
    );
    expect(partial).toMatchObject({
      ok: true,
      data: {
        audit: {
          expectedTradingDays: 4,
          observedTradingDays: 3,
          completeness: 'partial',
          missingDates: ['2026-07-06'],
        },
      },
    });
  });

  it('长区间审计按重叠区间读取快照，不被最新的非重叠快照遮蔽', async () => {
    const ctx = await buildTestContext();
    const accountId = ctx.user.defaultAccountId;
    const first = await getAccountPerformanceTool.execute(
      {
        accountId,
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-03T00:00:00.000Z'),
      },
      ctx,
    );
    const later = await getAccountPerformanceTool.execute(
      {
        accountId,
        from: new Date('2026-07-04T00:00:00.000Z'),
        to: new Date('2026-07-04T00:00:00.000Z'),
      },
      ctx,
    );
    expect(first.ok).toBe(true);
    expect(later.ok).toBe(true);
    const audit = await auditPortfolioPerformanceSnapshotsTool.execute(
      {
        accountId,
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-03T00:00:00.000Z'),
        limit: 1,
      },
      ctx,
    );
    expect(audit).toMatchObject({
      ok: true,
      data: {
        audit: {
          observedTradingDays: 3,
          missingDates: [],
          completeness: 'complete',
        },
      },
    });
  });

  it('区间审计采用最新事实修订，旧 complete 不掩盖新的 partial', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-07-04T00:00:00.000Z'),
    });
    const accountId = ctx.user.defaultAccountId;
    const first = await getAccountPerformanceTool.execute(
      {
        accountId,
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-03T00:00:00.000Z'),
      },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const original = await ctx.repos.portfolioPerformanceSnapshot.findById(
      first.data.audit?.snapshotId ?? '',
    );
    expect(original).not.toBeNull();
    if (original === null) return;
    await ctx.repos.portfolioPerformanceSnapshot.save({
      ...original,
      id: 'performance-revision-partial',
      inputFingerprint: 'revision-partial',
      calculatedAt: new Date('2026-07-05T00:00:00.000Z'),
      performance: {
        ...original.performance,
        completeness: 'partial',
        twrPct: undefined,
        maxDrawdownPct: undefined,
        warnings: ['输入事实修订后发现停牌缺价，收益指标保持 unavailable'],
        valuation: original.performance.valuation.map((day, index) =>
          index === 0
            ? {
                ...day,
                holdingsValue: undefined,
                totalValue: undefined,
                completeness: 'partial',
                missingStockIds: ['600519.SH'],
                twrReturnPct: undefined,
                cumulativeTwrPct: undefined,
                drawdownPct: undefined,
              }
            : day,
        ),
        audit: undefined,
      },
    });
    const audit = await auditPortfolioPerformanceSnapshotsTool.execute(
      {
        accountId,
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-03T00:00:00.000Z'),
      },
      ctx,
    );
    expect(audit).toMatchObject({
      ok: true,
      data: {
        audit: {
          completeness: 'partial',
          partialDayCount: 1,
          revisionDayCount: 3,
          gaps: [
            {
              date: '2026-07-01',
              snapshotId: 'performance-revision-partial',
              revisionCount: 2,
              missingStockIds: ['600519.SH'],
            },
          ],
        },
      },
    });
  });

  it('本地只有部分区间日线时会向行情 adapter 补齐并合并已知事实', async () => {
    const base = await buildTestContext();
    const accountId = base.user.defaultAccountId;
    const cachedBar: DailyBar = {
      stockId: '600519.SH',
      date: new Date('2026-07-01T00:00:00.000Z'),
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100),
      volume: 1000,
      adjustment: 'qfq' as const,
      source: 'cached-real',
    };
    await base.repos.dailyBar.saveMany([cachedBar]);
    const fetchedDates: string[] = [];
    const ctx = {
      ...base,
      adapters: {
        ...base.adapters,
        market: {
          ...base.adapters.market,
          fetchDailyBars: async (stockId: string, range: DateRange): Promise<DailyBar[]> => {
            fetchedDates.push(`${stockId}:${range.start.toISOString()}:${range.end.toISOString()}`);
            return [
              cachedBar,
              {
                ...cachedBar,
                date: new Date('2026-07-02T00:00:00.000Z'),
                close: money(102),
                source: 'provider-real',
              },
              {
                ...cachedBar,
                date: new Date('2026-07-03T00:00:00.000Z'),
                close: money(103),
                source: 'provider-real',
              },
            ];
          },
        },
      },
    };

    const result = await getAccountPerformanceTool.execute(
      {
        accountId,
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-03T00:00:00.000Z'),
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(fetchedDates.length).toBeGreaterThan(0);
    expect(
      await base.repos.dailyBar.findInRange(
        '600519.SH',
        new Date('2026-07-01T00:00:00.000Z'),
        new Date('2026-07-03T00:00:00.000Z'),
      ),
    ).toHaveLength(3);
  });

  it('行情 provider 失败时保留部分本地事实并返回不完整语义', async () => {
    const base = await buildTestContext();
    const cachedBar: DailyBar = {
      stockId: '600519.SH',
      date: new Date('2026-07-01T00:00:00.000Z'),
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100),
      volume: 1000,
      adjustment: 'qfq',
      source: 'cached-provider',
    };
    await base.repos.dailyBar.saveMany([cachedBar]);
    const ctx = {
      ...base,
      adapters: {
        ...base.adapters,
        market: {
          ...base.adapters.market,
          fetchDailyBars: async (): Promise<DailyBar[]> => {
            throw new Error('network: provider unavailable');
          },
        },
      },
    };
    const result = await getAccountPerformanceTool.execute(
      {
        accountId: base.user.defaultAccountId,
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-03T00:00:00.000Z'),
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.completeness).not.toBe('complete');
    expect(result.data.valuation.some((day) => day.missingStockIds.length > 0)).toBe(true);
    expect(
      await base.repos.dailyBar.findInRange(
        '600519.SH',
        new Date('2026-07-01T00:00:00.000Z'),
        new Date('2026-07-03T00:00:00.000Z'),
      ),
    ).toEqual([cachedBar]);
  });

  it('提供不触发行情请求的绩效快照审计摘要', async () => {
    const ctx = await buildTestContext();
    const input = {
      accountId: ctx.user.defaultAccountId,
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-03T00:00:00.000Z'),
    };
    const performance = await getAccountPerformanceTool.execute(input, ctx);
    expect(performance.ok).toBe(true);
    const audit = await listPortfolioPerformanceSnapshotsTool.execute(
      { accountId: input.accountId, limit: 10 },
      ctx,
    );
    expect(audit).toMatchObject({
      ok: true,
      data: { snapshots: [{ accountId: input.accountId }] },
    });
    if (!audit.ok) return;
    expect(audit.data.snapshots[0]).toMatchObject({
      completeness: 'complete',
      valuationDays: 3,
      inputFingerprint: expect.any(String),
    });
  });

  it('样本不足只报 insufficient 与覆盖事实，快照摘要不给百分比', async () => {
    const ctx = await buildTestContext();
    const accountId = ctx.user.defaultAccountId;
    const input = {
      accountId,
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-03T00:00:00.000Z'),
    };
    const performance = await getAccountPerformanceTool.execute(input, ctx);
    expect(performance.ok).toBe(true);
    if (!performance.ok) return;
    // 3 个交易日 = 噪声：状态是 insufficient，三个百分比字段全部缺席。
    expect(performance.data.metrics).toEqual({
      twr: { status: 'insufficient', reason: 'sample-too-small' },
      benchmarkTwr: { status: 'unavailable', reason: 'benchmark-not-configured' },
      excessTwr: { status: 'unavailable', reason: 'benchmark-unavailable' },
    });
    expect(performance.data.twrPct).toBeUndefined();
    expect(performance.data.benchmarkTwrPct).toBeUndefined();
    expect(performance.data.excessTwrPct).toBeUndefined();
    expect(performance.data.coverage).toEqual({
      status: 'complete',
      expectedTradingDays: 3,
      completeTradingDays: 3,
      missingDates: [],
      sampleDays: 3,
      requiredSampleDays: 20,
    });
    expect(performance.data.warnings).toContain('TWR 样本不足：完整估值日 3 < 20，未给出百分比');

    const summary = await listPortfolioPerformanceSnapshotsTool.execute(
      { accountId, limit: 10 },
      ctx,
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const snapshot = summary.data.snapshots[0];
    expect(snapshot?.metrics?.twr).toEqual({ status: 'insufficient', reason: 'sample-too-small' });
    expect(snapshot?.twrPct).toBeUndefined();
    expect(snapshot?.benchmarkTwrPct).toBeUndefined();
    expect(snapshot?.excessTwrPct).toBeUndefined();
    expect(snapshot?.coverage?.requiredSampleDays).toBe(20);
    expect(snapshot?.attribution.length).toBeGreaterThan(0);
    for (const row of snapshot?.attribution ?? []) expect(row.factIds.length).toBeGreaterThan(0);
  });

  it('存量快照没有覆盖/样本字段与 fact id 时如实报「无法判定」，不补默认值', async () => {
    const ctx = await buildTestContext();
    const accountId = ctx.user.defaultAccountId;
    const performance = await getAccountPerformanceTool.execute(
      {
        accountId,
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-03T00:00:00.000Z'),
      },
      ctx,
    );
    expect(performance.ok).toBe(true);
    if (!performance.ok) return;
    const current = await ctx.repos.portfolioPerformanceSnapshot.findById(
      performance.data.audit?.snapshotId ?? '',
    );
    expect(current).not.toBeNull();
    if (current === null) return;
    // 模拟 REQ-M3-07 之前的存量快照：没有 coverage / metrics，归因也没有 fact id。
    await ctx.repos.portfolioPerformanceSnapshot.save({
      ...current,
      id: 'performance-legacy-snapshot',
      inputFingerprint: 'legacy-fingerprint',
      performance: {
        ...current.performance,
        coverage: undefined,
        metrics: undefined,
        twrPct: 1.23,
        contributions: current.performance.contributions.map((item) => ({
          ...item,
          factIds: undefined,
        })),
      },
    });
    const summary = await listPortfolioPerformanceSnapshotsTool.execute(
      { accountId, limit: 10 },
      ctx,
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const legacy = summary.data.snapshots.find((item) => item.id === 'performance-legacy-snapshot');
    expect(legacy).toBeDefined();
    if (legacy === undefined) return;
    // 不补默认 complete / 0：字段缺席就是缺席，并把「无法判定」写进 warnings。
    expect(legacy.coverage).toBeUndefined();
    expect(legacy.metrics).toBeUndefined();
    expect(legacy.warnings).toContain('快照早于覆盖/样本字段，无法判定 TWR 样本是否充足');
    expect(legacy.warnings).toContain('部分归因缺少 fact id，无法追溯到账本事实');
    expect(legacy.attribution.every((row) => row.factIds.length === 0)).toBe(true);
    // 口径未知的百分比一律不转述（快照里存的 1.23 不出现）。
    expect(legacy.twrPct).toBeUndefined();
    expect(legacy.benchmarkTwrPct).toBeUndefined();
    expect(legacy.excessTwrPct).toBeUndefined();
  });

  it('覆盖缺口只返回状态与缺失日期，不填 0 也不给百分比', async () => {
    const base = await buildTestContext();
    const ctx = {
      ...base,
      adapters: {
        ...base.adapters,
        market: {
          ...base.adapters.market,
          fetchDailyBars: async (): Promise<DailyBar[]> => {
            throw new Error('network: provider unavailable');
          },
        },
      },
    };
    const result = await getAccountPerformanceTool.execute(
      {
        accountId: base.user.defaultAccountId,
        from: new Date('2026-07-01T00:00:00.000Z'),
        to: new Date('2026-07-06T00:00:00.000Z'),
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.coverage).toMatchObject({
      status: 'partial',
      expectedTradingDays: 4,
      completeTradingDays: 0,
      missingDates: ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06'],
      sampleDays: 0,
    });
    expect(result.data.metrics?.twr).toEqual({ status: 'unavailable', reason: 'coverage-gap' });
    expect(result.data.twrPct).toBeUndefined();
    expect(result.data.benchmarkTwrPct).toBeUndefined();
    expect(result.data.excessTwrPct).toBeUndefined();
    // 缺价日不给 0 总市值，也不给日收益。
    for (const day of result.data.valuation) {
      expect(day.totalValue).toBeUndefined();
      expect(day.twrReturnPct).toBeUndefined();
    }
  });

  it('样本达标时给出 TWR / 基准 TWR / 超额，归因 fact id 可回表核对', async () => {
    const base = await buildTestContext();
    const ctx = {
      ...base,
      portfolioBenchmark: { stockId: '000300.SH', name: '沪深300' },
    };
    const input = {
      accountId: base.user.defaultAccountId,
      from: new Date('2026-06-01T00:00:00.000Z'),
      to: new Date('2026-06-30T00:00:00.000Z'),
    };
    const result = await getAccountPerformanceTool.execute(input, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.coverage?.status).toBe('complete');
    expect(result.data.coverage?.expectedTradingDays).toBeGreaterThanOrEqual(20);
    expect(result.data.metrics).toEqual({
      twr: { status: 'available' },
      benchmarkTwr: { status: 'available' },
      excessTwr: { status: 'available' },
    });
    expect(typeof result.data.twrPct).toBe('number');
    expect(typeof result.data.benchmarkTwrPct).toBe('number');
    expect(result.data.excessTwrPct).toBeCloseTo(
      (result.data.twrPct ?? 0) - (result.data.benchmarkTwrPct ?? 0),
      8,
    );

    const summary = await listPortfolioPerformanceSnapshotsTool.execute(
      { accountId: input.accountId, limit: 10 },
      ctx,
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const snapshot = summary.data.snapshots[0];
    expect(snapshot?.metrics?.excessTwr).toEqual({ status: 'available' });
    expect(snapshot?.twrPct).toBe(result.data.twrPct);
    expect(snapshot?.benchmarkTwrPct).toBe(result.data.benchmarkTwrPct);
    expect(snapshot?.excessTwrPct).toBe(result.data.excessTwrPct);

    // 归因不是自由文本：每个 fact id 都能在事实库里查到对应记录。
    const factIds = (snapshot?.attribution ?? []).flatMap((row) => row.factIds);
    expect(factIds.length).toBeGreaterThan(0);
    for (const factId of factIds) {
      const [kind, rest] = [
        factId.slice(0, factId.indexOf(':')),
        factId.slice(factId.indexOf(':') + 1),
      ];
      if (kind === 'trade') expect(await ctx.repos.trade.findById(rest)).not.toBeNull();
      else if (kind === 'cash-flow')
        expect(await ctx.repos.portfolioCashFlow.findById(rest)).not.toBeNull();
      else if (kind === 'corporate-action')
        expect(await ctx.repos.portfolioCorporateAction.findById(rest)).not.toBeNull();
      else if (kind === 'holding') expect(await ctx.repos.holding.findById(rest)).not.toBeNull();
      else if (kind === 'daily_bar') {
        const [stockId, day] = [
          rest.slice(0, rest.lastIndexOf(':')),
          rest.slice(rest.lastIndexOf(':') + 1),
        ];
        const bars = await ctx.repos.dailyBar.findInRange(
          stockId,
          new Date(`${day}T00:00:00.000Z`),
          new Date(`${day}T00:00:00.000Z`),
        );
        expect(bars).toHaveLength(1);
      } else throw new Error(`unexpected fact id kind: ${factId}`);
    }
  });
});
