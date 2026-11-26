import {
  type LimitUpMarketManagerLike,
  type LimitUpMarketSnapshot,
  THEME_LIBRARY_AUTO_SOURCE,
  themeLibraryRuleThemeId,
} from '@luoome/core';
import { runThemeLibraryAutoMaintenanceTool } from '@luoome/toolkit/tools/theme-library-auto.js';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

const TRADING_DAY = '2026-11-26';
const ROBOTICS = themeLibraryRuleThemeId('机器人与具身智能');

const at = (time: string, day = TRADING_DAY): Date => new Date(`${day}T${time}+08:00`);

const poolEntry = (input: {
  stockId: string;
  name: string;
  reason: string | null;
  continueDayCnt?: number;
}) => ({
  stockId: input.stockId,
  code: input.stockId.slice(0, 6),
  name: input.name,
  isSt: false,
  isNew: false,
  price: 10,
  changePct: 0.1,
  limitUpTime: '09:35',
  openTimes: 0,
  reason: input.reason,
  continueDayText: '首板',
  continueDayCnt: input.continueDayCnt ?? 1,
  sealMoney: 1_000_000,
  maxSealMoney: 1_000_000,
});

const snapshot = (input: {
  date?: string;
  entries?: ReturnType<typeof poolEntry>[];
  total?: number;
  statisticsCount?: number | null;
}): LimitUpMarketSnapshot => {
  const entries = input.entries ?? [];
  return {
    date: input.date ?? TRADING_DAY,
    source: 'fuyao',
    asOf: at('15:20'),
    dataAsOf: at('15:10'),
    pool: { total: input.total ?? entries.length, entries },
    statistics:
      input.statisticsCount === null
        ? null
        : {
            tradeDate: TRADING_DAY,
            sealRate: 0.6,
            openStockCount: 5,
            limitUpStockCount: input.statisticsCount ?? entries.length,
            touchedLimitUpStockCount: entries.length + 5,
            pageBoards: [],
            exactBoards: [],
          },
    ladder: null,
    warnings: [],
  };
};

const manager = (
  result: Awaited<ReturnType<LimitUpMarketManagerLike['fetchMarket']>>,
): LimitUpMarketManagerLike => ({
  name: 'limit-up-market',
  sources: ['fuyao'],
  status: () => [],
  fetchMarket: async () => result,
});

const seedLibrary = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  await ctx.repos.themeLibrary.importSeed({
    importId: 'seed-1',
    source: 'fuyao-concept',
    appliedAt: at('08:00'),
    seed: {
      themes: [
        {
          id: ROBOTICS,
          name: '机器人',
          sortOrder: 0,
          sources: [{ vendorCode: '885728.TI', sectorId: 'concept-1', name: '机器人概念' }],
          stockIds: ['600519.SH'],
        },
      ],
      skipped: [],
    },
  });
};

const seedConcepts = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  await ctx.repos.sectorCatalog.applySync({
    syncId: 'sector-sync-1',
    source: 'fuyao',
    appliedAt: at('08:00'),
    status: 'succeeded',
    catalog: [{ kind: 'concept', vendorCode: '886001.TI', name: '钙钛矿' }],
    catalogKinds: ['concept'],
    observations: [
      {
        stockId: '300011.SZ',
        sectors: [{ kind: 'concept', vendorCode: '886001.TI', name: '钙钛矿' }],
      },
      {
        stockId: '300012.SZ',
        sectors: [{ kind: 'concept', vendorCode: '886001.TI', name: '钙钛矿' }],
      },
    ],
    stockStatuses: [],
    failures: [],
  });
};

describe('run_theme_library_auto_maintenance tool', () => {
  it('盘后按主催化补成分、建新方向并把无归属留在待核对', async () => {
    const ctx = await buildTestContext({
      clock: () => at('16:05'),
      limitUpMarket: manager({
        ok: true,
        data: snapshot({
          entries: [
            poolEntry({ stockId: '300001.SZ', name: '甲', reason: '工业机器人+减速器' }),
            poolEntry({ stockId: '300011.SZ', name: '乙', reason: '钙钛矿' }),
            poolEntry({ stockId: '300012.SZ', name: '丙', reason: '钙钛矿+异质结' }),
            poolEntry({ stockId: '600001.SH', name: '丁', reason: '量子织布机' }),
          ],
        }),
      }),
    });
    await seedLibrary(ctx);
    await seedConcepts(ctx);

    const result = await runThemeLibraryAutoMaintenanceTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('succeeded');
    expect(result.data.tradingDay).toBe(TRADING_DAY);
    expect(result.data.createdThemes).toBe(1);
    expect(result.data.createdMembers).toBe(3);
    expect(result.data.pendingCount).toBe(1);
    expect(result.data.effectiveFrom).toEqual(at('15:00'));
    expect(result.data.appliedAt).toEqual(at('16:05'));

    const themes = await ctx.repos.themeLibrary.listThemes({ state: 'all' });
    expect(themes.map((theme) => theme.name).sort()).toEqual(['机器人', '钙钛矿'].sort());
    const members = await ctx.repos.themeLibrary.listMembers();
    expect(members.filter((member) => member.origin === 'auto')).toHaveLength(3);

    // 同日重复执行：直接返回原结果，不重复写
    const again = await runThemeLibraryAutoMaintenanceTool.execute({}, ctx);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.createdMembers).toBe(3);
    expect(await ctx.repos.themeLibrary.listMembers()).toHaveLength(4);
  });

  it('收盘前跳过并记录原因，不写任何成分', async () => {
    const ctx = await buildTestContext({
      clock: () => at('14:30'),
      limitUpMarket: manager({ ok: true, data: snapshot({ entries: [] }) }),
    });
    await seedLibrary(ctx);
    const result = await runThemeLibraryAutoMaintenanceTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('skipped');
    expect(result.data.skipReason).toBe('before_close');
    expect(await ctx.repos.themeLibrary.listMembers()).toHaveLength(1);
  });

  it('空池跳过（休市 / 上游未更新），不入审计为成功', async () => {
    const ctx = await buildTestContext({
      clock: () => at('16:05'),
      limitUpMarket: manager({ ok: true, data: snapshot({ entries: [] }) }),
    });
    await seedLibrary(ctx);
    const result = await runThemeLibraryAutoMaintenanceTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('skipped');
    expect(result.data.skipReason).toBe('empty_pool');
    expect(result.data.createdMembers).toBe(0);
  });

  it('涨停池不完整时跳过，不写库', async () => {
    const ctx = await buildTestContext({
      clock: () => at('16:05'),
      limitUpMarket: manager({
        ok: true,
        data: snapshot({
          entries: [poolEntry({ stockId: '300001.SZ', name: '甲', reason: '机器人' })],
          total: 40,
        }),
      }),
    });
    await seedLibrary(ctx);
    const result = await runThemeLibraryAutoMaintenanceTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('skipped');
    expect(result.data.skipReason).toBe('incomplete_pool');
  });

  it('数据源未配置时记录失败并返回 adapter_error', async () => {
    const ctx = await buildTestContext({ clock: () => at('16:05') });
    await seedLibrary(ctx);
    const result = await runThemeLibraryAutoMaintenanceTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('adapter_error');
    const run = await ctx.repos.themeLibrary.findAutoRun({
      tradingDay: TRADING_DAY,
      source: THEME_LIBRARY_AUTO_SOURCE,
    });
    expect(run?.status).toBe('failed');
    expect(run?.errorKind).toBe('adapter_error');
  });

  it('上游失败后允许重试成功', async () => {
    let fail = true;
    const ctx = await buildTestContext({
      clock: () => at('16:05'),
      limitUpMarket: {
        name: 'limit-up-market',
        sources: ['fuyao'],
        status: () => [],
        fetchMarket: async () =>
          fail
            ? {
                ok: false,
                error: {
                  kind: 'adapter_error' as const,
                  adapter: 'limit-up-market' as const,
                  message: '上游超时',
                  recoverable: true,
                },
              }
            : {
                ok: true,
                data: snapshot({
                  entries: [poolEntry({ stockId: '300001.SZ', name: '甲', reason: '机器人' })],
                }),
              },
      },
    });
    await seedLibrary(ctx);
    const first = await runThemeLibraryAutoMaintenanceTool.execute({}, ctx);
    expect(first.ok).toBe(false);
    fail = false;
    const second = await runThemeLibraryAutoMaintenanceTool.execute({}, ctx);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.status).toBe('succeeded');
    expect(second.data.attempt).toBe(2);
    expect(second.data.createdMembers).toBe(1);
  });

  it('未来日期与非交易日直接拒绝，不写执行记录', async () => {
    const ctx = await buildTestContext({ clock: () => at('16:05') });
    const future = await runThemeLibraryAutoMaintenanceTool.execute(
      { tradingDate: '2026-12-01' },
      ctx,
    );
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error.kind).toBe('invalid_input');
    const holiday = await runThemeLibraryAutoMaintenanceTool.execute(
      { tradingDate: '2026-11-21' },
      ctx,
    );
    expect(holiday.ok).toBe(false);
    if (!holiday.ok) expect(holiday.error.kind).toBe('invalid_input');
    expect(await ctx.repos.themeLibrary.listAutoRuns()).toHaveLength(0);
  });

  it('补跑漏日按该交易日收盘生效，不回灌盘中', async () => {
    const ctx = await buildTestContext({
      clock: () => at('16:05', '2026-11-30'),
      limitUpMarket: manager({
        ok: true,
        data: snapshot({
          entries: [poolEntry({ stockId: '300001.SZ', name: '甲', reason: '机器人' })],
        }),
      }),
    });
    await seedLibrary(ctx);
    const result = await runThemeLibraryAutoMaintenanceTool.execute(
      { tradingDate: TRADING_DAY },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.effectiveFrom).toEqual(at('15:00'));
    const member = (await ctx.repos.themeLibrary.listMembers({ themeIds: [ROBOTICS] })).find(
      (row) => row.stockId === '300001.SZ',
    );
    expect(member?.effectiveFrom).toEqual(at('15:00'));
  });

  it('人工删除过的股票不会被后续自动任务加回', async () => {
    const ctx = await buildTestContext({
      clock: () => at('16:05'),
      limitUpMarket: manager({
        ok: true,
        data: snapshot({
          entries: [poolEntry({ stockId: '300001.SZ', name: '甲', reason: '机器人' })],
        }),
      }),
    });
    await seedLibrary(ctx);
    await runThemeLibraryAutoMaintenanceTool.execute({}, ctx);
    await ctx.repos.themeLibrary.removeMember({
      themeId: ROBOTICS,
      stockId: '300001.SZ',
      at: at('17:00'),
    });
    const again = await runThemeLibraryAutoMaintenanceTool.execute(
      { tradingDate: '2026-11-27' },
      {
        ...ctx,
        clock: () => at('16:05', '2026-11-27'),
      },
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.createdMembers).toBe(0);
  });
});
