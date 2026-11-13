import type {
  DragonTigerFlowDay,
  DragonTigerFlowQuery,
  DragonTigerFlowRangeDays,
  Logger,
} from '@luoome/core';
import { DragonTigerFlowQuerySchema } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { DragonTigerFlowManager, type DragonTigerFlowSourceLike } from './flow-manager.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CLOCK = () => new Date('2026-11-11T12:00:00.000+08:00');

const TRADING_DATES = [
  '2026-10-26',
  '2026-10-27',
  '2026-10-28',
  '2026-10-29',
  '2026-10-30',
  '2026-11-02',
  '2026-11-03',
  '2026-11-04',
  '2026-11-05',
  '2026-11-06',
  '2026-11-09',
  '2026-11-10',
  '2026-11-11',
];

const boardDay = (date: string, netAmount = 100): DragonTigerFlowDay => ({
  date,
  stocks: [
    {
      code: '600547',
      name: '山东黄金',
      changePct: 0.05,
      netAmount,
      orgNetAmount: netAmount / 2,
      hotNetAmount: netAmount / 4,
      buyAmount: 200,
      sellAmount: 100,
      amount: 1000,
      concepts: ['黄金'],
    },
  ],
});

const mkSource = (
  overrides: {
    fetchTradingDays?: (startDate: string, endDate: string) => Promise<string[]>;
    fetchBoard?: (date: string, rangeDays: DragonTigerFlowRangeDays) => Promise<DragonTigerFlowDay>;
  } = {},
) => ({
  name: 'fuyao',
  fetchTradingDays: vi.fn(
    overrides.fetchTradingDays ?? (async (_startDate: string, _endDate: string) => TRADING_DATES),
  ),
  fetchBoard: vi.fn(
    overrides.fetchBoard ??
      (async (date: string, _rangeDays: DragonTigerFlowRangeDays) => boardDay(date)),
  ),
});

const query = (input: Record<string, unknown> = {}): DragonTigerFlowQuery =>
  DragonTigerFlowQuerySchema.parse({ date: '2026-11-11', days: 5, ...input });

const mkManager = (source: DragonTigerFlowSourceLike, clock = CLOCK) =>
  new DragonTigerFlowManager({ source, logger: noopLogger, clock });

describe('DragonTigerFlowManager', () => {
  it('解析最近 N 个交易日并聚合出累计轨迹', async () => {
    const source = mkSource();
    const r = await mkManager(source).fetchFlow(query());
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) return;
    expect(r.data.tradingDates).toEqual([
      '2026-11-05',
      '2026-11-06',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
    ]);
    expect(r.data.days).toBe(5);
    expect(r.data.concepts[0]?.series).toEqual([100, 200, 300, 400, 500]);
    expect(r.data.stats.stockCount).toBe(1);
    expect(source.fetchBoard).toHaveBeenCalledTimes(7);
    expect(source.fetchTradingDays).toHaveBeenCalledTimes(1);
  });

  it('请求非交易日 → 向前对齐并给 warning', async () => {
    const source = mkSource();
    const r = await mkManager(source).fetchFlow(query({ date: '2026-11-08', days: 5 }));
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) return;
    expect(r.data.endDate).toBe('2026-11-06');
    expect(r.data.warnings).toContain('non-trading-day:2026-11-08');
  });

  it('请求未来日期 → 夹到今天并给 future-date warning', async () => {
    const r = await mkManager(mkSource()).fetchFlow(query({ date: '2026-11-20', days: 5 }));
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) return;
    expect(r.data.endDate).toBe('2026-11-11');
    expect(r.data.warnings).toContain('future-date:2026-11-20');
  });

  it('单日失败 → partial-data warning，其余交易日仍入轨迹', async () => {
    const source = mkSource({
      fetchBoard: vi.fn(async (date: string) => {
        if (date === '2026-11-09') throw new Error('boom');
        return boardDay(date);
      }),
    });
    const r = await mkManager(source).fetchFlow(query({ days: 5 }));
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) return;
    expect(r.data.days).toBe(5);
    expect(r.data.warnings).toContain('partial-data:1');
    expect(r.data.stats.stockCount).toBe(1);
  });

  it('全部交易日失败 → adapter_error', async () => {
    const source = mkSource({
      fetchBoard: vi.fn(async () => {
        throw new Error('down');
      }),
    });
    const r = await mkManager(source).fetchFlow(query({ days: 5 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.kind).toBe('adapter_error');
    expect(r.error?.message).toContain('down');
  });

  it('交易日历不可用 → 回退内置日历并给 calendar-fallback warning', async () => {
    const source = mkSource({
      fetchTradingDays: vi.fn(async () => {
        throw new Error('calendar down');
      }),
    });
    const r = await mkManager(source).fetchFlow(query({ days: 5 }));
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) return;
    expect(r.data.warnings).toContain('calendar-fallback');
    expect(r.data.tradingDates).toEqual([
      '2026-11-05',
      '2026-11-06',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
    ]);
  });

  it('TTL 内重复请求命中 flow 缓存，不再打上游', async () => {
    const source = mkSource();
    const manager = mkManager(source);
    await manager.fetchFlow(query());
    await manager.fetchFlow(query());
    expect(source.fetchBoard).toHaveBeenCalledTimes(7);
    expect(source.fetchTradingDays).toHaveBeenCalledTimes(1);
  });

  it('board 缓存按 (date, rangeDays) 复用，切换 days 只补拉新增日', async () => {
    const source = mkSource();
    const manager = mkManager(source);
    await manager.fetchFlow(query({ days: 5 }));
    await manager.fetchFlow(query({ days: 10 }));
    // 5 日窗口探测 7 个交易日；10 日窗口探测 12 个 → 复用 7 个，新增 5 个
    expect(source.fetchBoard).toHaveBeenCalledTimes(12);
  });

  it('最近交易日榜单未发布 → 整体前移并给 latest-day-pending warning', async () => {
    const source = mkSource({
      fetchBoard: vi.fn(async (date: string) =>
        date === '2026-11-11' ? { date, stocks: [] } : boardDay(date),
      ),
    });
    const r = await mkManager(source).fetchFlow(query({ days: 5 }));
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) return;
    expect(r.data.endDate).toBe('2026-11-10');
    expect(r.data.days).toBe(5);
    expect(r.data.tradingDates).toEqual([
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-09',
      '2026-11-10',
    ]);
    expect(r.data.warnings).toContain('latest-day-pending:1');
  });

  it('空交易日不进 board 缓存：收盘后发布能被下一次刷新捡到', async () => {
    let now = new Date('2026-11-11T12:00:00.000+08:00');
    const fetchBoard = vi.fn(async (date: string) =>
      date === '2026-11-11' ? { date, stocks: [] } : boardDay(date),
    );
    const source = mkSource({ fetchBoard });
    const manager = mkManager(source, () => now);
    await manager.fetchFlow(query({ days: 5 }));
    now = new Date('2026-11-11T12:01:30.000+08:00');
    await manager.fetchFlow(query({ days: 5 }));
    // 首轮 7 个候选日；第二轮 6 个非空日命中缓存 + 空日重拉 = 8 次
    expect(fetchBoard).toHaveBeenCalledTimes(8);
  });

  it('status 暴露 fuyao 源与最近成功时间', async () => {
    const manager = mkManager(mkSource());
    await manager.fetchFlow(query());
    const status = manager.status();
    expect(status[0]).toMatchObject({
      dataset: 'dragon-tiger-flow',
      source: 'fuyao',
      capabilityEnabled: true,
      configurationReady: true,
    });
    expect(status[0]?.lastSuccessAt).toBeInstanceOf(Date);
  });
});
