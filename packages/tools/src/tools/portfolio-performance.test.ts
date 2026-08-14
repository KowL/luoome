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
    expect(first.data.audit).toMatchObject({ inputFingerprint: expect.any(String) });
    expect(second.data.audit).toEqual(first.data.audit);
    expect(first.data.benchmarkStockId).toBe('000300.SH');
    expect(
      await ctx.repos.portfolioPerformanceSnapshot.listByAccount(input.accountId),
    ).toHaveLength(1);
    expect(fetchCount).toBeGreaterThan(0);
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
});
