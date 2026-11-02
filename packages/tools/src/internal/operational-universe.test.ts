import { stockCode } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { excludeUntradeableStockIds, UNTRADEABLE_GRACE_DAYS } from './operational-universe.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-02T10:00:00.000Z');

const applySnapshot = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  syncId: string,
  observedAt: Date,
  stockIds: readonly string[],
): Promise<void> => {
  await ctx.repos.stockUniverse.applySnapshot({
    syncId,
    appliedAt: observedAt,
    snapshot: {
      source: 'eastmoney',
      coverage: 'CN_A_SHARES_SH_SZ',
      observedAt,
      complete: true,
      reportedTotal: stockIds.length,
      entries: stockIds.map((stockId) => ({
        stockId,
        code: stockCode(stockId.slice(0, 6)),
        exchange: stockId.endsWith('.SH') ? ('SH' as const) : ('SZ' as const),
        name: stockId,
        listingStatus: 'unknown' as const,
      })),
    },
  });
};

describe('excludeUntradeableStockIds', () => {
  it('剔除「窗口外且从未有过日线」的成员，窗口内的新成员照常保留', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const longAgo = new Date(NOW.getTime() - (UNTRADEABLE_GRACE_DAYS + 30) * DAY_MS);
    const yesterday = new Date(NOW.getTime() - DAY_MS);

    // 第一轮：A（有日线）、B（退市）在很久以前就进了目录。
    await applySnapshot(ctx, 'sync-old', longAgo, ['600519.SH', '000003.SZ']);
    // 第二轮：C 昨天才出现（新上市），A/B 的 firstSeenAt 不应被刷新。
    await applySnapshot(ctx, 'sync-new', yesterday, ['600519.SH', '000003.SZ', '002594.SZ']);

    await ctx.repos.dailyBar.saveMany([
      {
        stockId: '600519.SH',
        date: new Date('2026-10-30T00:00:00.000Z'),
        open: 1 as never,
        high: 1 as never,
        low: 1 as never,
        close: 1 as never,
        volume: 100,
        adjustment: 'qfq',
        source: 'sina',
      },
    ]);

    const result = await excludeUntradeableStockIds(
      ctx,
      ['600519.SH', '000003.SZ', '002594.SZ'],
      NOW,
    );

    expect(result.untradeable).toEqual(['000003.SZ']);
    expect(result.kept).toEqual(['600519.SH', '002594.SZ']);
  });

  it('没有任何目录观察记录的成员保留（不因缺 firstSeenAt 被误杀）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const result = await excludeUntradeableStockIds(ctx, ['600519.SH'], NOW);
    expect(result.untradeable).toEqual([]);
    expect(result.kept).toEqual(['600519.SH']);
  });

  it('空输入直接返回，不查库', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    expect(await excludeUntradeableStockIds(ctx, [], NOW)).toEqual({ kept: [], untradeable: [] });
  });
});
