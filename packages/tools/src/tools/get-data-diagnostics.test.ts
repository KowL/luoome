import { testAdviceFor } from '@luoome/adapters/testing';
import {
  EXPECTED_SCHEMA_MIGRATIONS,
  type MarketSourceStatus,
  type ToolContext,
} from '@luoome/core';
import { InMemorySchemaMigrationRepository } from '@luoome/db/memory';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { getDataDiagnosticsTool } from './get-data-diagnostics.js';

const NOW = new Date('2026-10-30T06:00:00.000Z');

const failingMarket = {
  source: 'eastmoney',
  marketSourceStatus: (): readonly MarketSourceStatus[] => [
    {
      dataset: 'stock-universe',
      source: 'eastmoney',
      coverage: ['CN_A_SHARES_SH_SZ'],
      capabilityEnabled: true,
      configurationReady: true,
      lastAttemptAt: new Date('2026-10-30T05:10:00.000Z'),
      lastErrorKind: 'network',
    },
  ],
};

const run = async (patch: (ctx: ToolContext) => ToolContext) => {
  const base = await buildTestContext({ clock: () => NOW });
  const result = await getDataDiagnosticsTool.execute({}, patch(base));
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return (
    result.data as {
      findings: {
        code: string;
        table: string;
        field: string;
        at: string | null;
        message: string;
      }[];
    }
  ).findings;
};

describe('T14 get_data_diagnostics', () => {
  it('缺行情：结论带 price_snapshots.observed_at 与日期', async () => {
    const findings = await run((ctx) => ({
      ...ctx,
      repos: {
        ...ctx.repos,
        quote: { ...ctx.repos.quote, latestByStocks: async () => new Map() },
        dailyBar: { ...ctx.repos.dailyBar, latestBefore: async () => [] },
        schemaMigration: new InMemorySchemaMigrationRepository(
          EXPECTED_SCHEMA_MIGRATIONS.map((id) => ({ id, appliedAt: NOW })),
        ),
      },
    }));
    const quote = findings.find((item) => item.code === 'market-quote-missing');
    expect(quote).toBeDefined();
    expect(quote).toMatchObject({ table: 'price_snapshots', field: 'observed_at', at: null });
    expect(quote?.message).toContain('price_snapshots');
    const bars = findings.find((item) => item.code === 'daily-bar-stale');
    expect(bars).toMatchObject({ table: 'daily_bars', field: 'trade_date', at: null });
  });

  it('迁移未完成：结论带 schema_migrations.id 与最近应用日期', async () => {
    const applied = new Date('2026-10-20T01:02:03.000Z');
    const findings = await run((ctx) => ({
      ...ctx,
      repos: {
        ...ctx.repos,
        schemaMigration: new InMemorySchemaMigrationRepository([
          { id: EXPECTED_SCHEMA_MIGRATIONS[0], appliedAt: applied },
        ]),
      },
    }));
    const migration = findings.find((item) => item.code === 'migration-incomplete');
    expect(migration).toMatchObject({ table: 'schema_migrations', field: 'id' });
    expect(new Date(String(migration?.at)).toISOString()).toBe(applied.toISOString());
    expect(migration?.message).toContain(EXPECTED_SCHEMA_MIGRATIONS[1]);
    expect(migration?.message).toContain('2026-10-20 01:02:03');
  });

  it('连接失败：结论带事实表、last_error_kind 与尝试时间', async () => {
    const findings = await run((ctx) => ({
      ...ctx,
      adapters: {
        ...ctx.adapters,
        market: failingMarket as unknown as ToolContext['adapters']['market'],
      },
      repos: {
        ...ctx.repos,
        schemaMigration: new InMemorySchemaMigrationRepository(
          EXPECTED_SCHEMA_MIGRATIONS.map((id) => ({ id, appliedAt: NOW })),
        ),
      },
    }));
    const source = findings.find((item) => item.code === 'source-unavailable');
    expect(source).toMatchObject({
      table: 'stock_universe_sync_runs',
      field: 'last_error_kind',
    });
    expect(new Date(String(source?.at)).toISOString()).toBe('2026-10-30T05:10:00.000Z');
    expect(source?.message).toContain('lastErrorKind=network');
  });

  it('连接失败（持久）：最近一次股票库同步失败，结论带表名与失败日期', async () => {
    const failedAt = new Date('2026-10-30T04:00:00.000Z');
    const findings = await run((ctx) => ({
      ...ctx,
      repos: {
        ...ctx.repos,
        stockUniverse: {
          ...ctx.repos.stockUniverse,
          latestSyncRun: async () => ({
            id: 'sync-1',
            source: 'eastmoney',
            coverage: 'CN_A_SHARES_SH_SZ',
            status: 'failed',
            startedAt: new Date('2026-10-30T03:59:00.000Z'),
            finishedAt: failedAt,
            observedAt: null,
            reportedTotal: null,
            observedCount: 0,
            createdStocks: 0,
            updatedStocks: 0,
            reactivated: 0,
            markedMissing: 0,
            errorKind: 'network',
          }),
        },
        schemaMigration: new InMemorySchemaMigrationRepository(
          EXPECTED_SCHEMA_MIGRATIONS.map((id) => ({ id, appliedAt: NOW })),
        ),
      },
    }));
    const persisted = findings.find(
      (item) => item.code === 'source-unavailable' && item.field === 'status',
    );
    expect(persisted).toMatchObject({ table: 'stock_universe_sync_runs', field: 'status' });
    expect(new Date(String(persisted?.at)).toISOString()).toBe(failedAt.toISOString());
    expect(persisted?.message).toContain('errorKind=network');
  });

  // T31：退化 plan 必须成为**可见指标**，而不是只能靠读代码发现。
  it('目标仓位区间：2 条退化（min===max）+ 1 条非退化 → degenerate 计数 2', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    const buy = testAdviceFor('600519.SH', () => NOW);
    await base.repos.advice.save({
      ...buy,
      id: 'buy-degenerate-1',
      decision: 'buy',
      targetPositionPctRange: { min: 10, max: 10 },
    });
    await base.repos.advice.save({
      ...buy,
      id: 'buy-degenerate-2',
      decision: 'buy',
      targetPositionPctRange: { min: 20, max: 20 },
    });
    await base.repos.advice.save({
      ...buy,
      id: 'buy-ranged',
      decision: 'buy',
      targetPositionPctRange: { min: 8, max: 12 },
    });
    const result = await getDataDiagnosticsTool.execute({}, base);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const ranges = (
      result.data as {
        targetPositionRanges: { checked: number; degenerate: number; ranged: number };
      }
    ).targetPositionRanges;
    expect(ranges.degenerate).toBe(2);
    expect(ranges.ranged).toBe(1);
    expect(ranges.checked).toBe(3);
    // 未达上限 → 不是截断，计数是全量
    expect((ranges as { truncated?: boolean }).truncated).toBe(false);
  });
});
