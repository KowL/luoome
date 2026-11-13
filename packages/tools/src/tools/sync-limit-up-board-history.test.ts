import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { syncLimitUpBoardHistoryTool } from './sync-limit-up-board-history.js';

const adapter = (options: { failBroken?: boolean; failPrevious?: boolean } = {}) => ({
  name: 'fake-limit-up',
  fetchLimitUpPool: async (date: string) => {
    if (options.failPrevious === true && date === '2026-11-11') {
      throw new Error('previous pool down');
    }
    return {
      date,
      rows:
        date === '2026-11-12'
          ? [{ stockId: '600000.SH', continueDayCnt: 3 }]
          : [
              { stockId: '600000.SH', continueDayCnt: 2 },
              { stockId: '600519.SH', continueDayCnt: 1 },
            ],
      publishedAt: new Date(`${date}T16:05:00+08:00`),
      fetchedAt: new Date(`${date}T16:06:00+08:00`),
    };
  },
  fetchLimitBreakPool: async (date: string) => {
    if (options.failBroken === true) throw new Error('break pool down');
    return {
      stockIds: date === '2026-11-12' ? ['600519.SH'] : [],
      publishedAt: new Date(`${date}T16:05:00+08:00`),
      fetchedAt: new Date(`${date}T16:06:00+08:00`),
    };
  },
});

describe('sync_limit_up_board_history', () => {
  it('采集封板/炸板/断板事实并写入 PIT', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-11-12T08:10:00.000Z'),
      limitUpBoard: adapter(),
    });

    const result = await syncLimitUpBoardHistoryTool.execute({ date: '2026-11-12' }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      tradeDate: '2026-11-12',
      status: 'complete',
      vintage: 'captured',
      facts: 2,
      broken: 1,
      boardBreaks: 1,
    });
    const stored = await ctx.repos.limitUpBoardHistory.findByDate({
      tradeDate: '2026-11-12',
      source: 'fuyao-limit-up',
    });
    expect(stored?.facts).toEqual([
      {
        stockId: '600000.SH',
        isBroken: false,
        consecutiveBoard: 2,
        isBoardBreak: false,
        missingFields: [],
      },
      {
        stockId: '600519.SH',
        isBroken: true,
        consecutiveBoard: 1,
        isBoardBreak: true,
        missingFields: [],
      },
    ]);
  });

  it('当日缺省采集标 captured，历史补采标 backfill', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-11-12T08:10:00.000Z'),
      limitUpBoard: adapter(),
    });
    const today = await syncLimitUpBoardHistoryTool.execute({}, ctx);
    expect(today.ok && today.data.vintage).toBe('captured');
    const backfill = await syncLimitUpBoardHistoryTool.execute({ date: '2026-11-10' }, ctx);
    expect(backfill.ok && backfill.data.vintage).toBe('backfill');
  });

  it('炸板池失败保留封板事实并标 partial', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-11-12T08:10:00.000Z'),
      limitUpBoard: adapter({ failBroken: true }),
    });
    const result = await syncLimitUpBoardHistoryTool.execute({ date: '2026-11-12' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('partial');
    expect(result.data.missingFields).toContain('limit-break-pool');
  });

  it('未配置数据源或非交易日时拒绝执行', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-11-14T08:10:00.000Z'),
    });
    const missing = await syncLimitUpBoardHistoryTool.execute({ date: '2026-11-12' }, ctx);
    expect(missing.ok ? null : missing.error.kind).toBe('invalid_input');

    const weekend = await syncLimitUpBoardHistoryTool.execute({}, ctx);
    expect(weekend.ok ? null : weekend.error.kind).toBe('invalid_input');
  });
});
