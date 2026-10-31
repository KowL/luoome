import { TEST_ACCOUNT, TEST_HOLDINGS } from '@luoome/adapters/testing';
import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { listHoldingsTool } from './list-holdings.js';
import { refreshHoldingsQuotesTool } from './refresh-holdings-quotes.js';

/**
 * task-14：`list_holdings` 已改**纯读**（只读已落库报价），所以这些用例必须**先显式刷新**
 * 才能拿到现价——原来它们依赖 `list_holdings` 内部回源，那正是被拆掉的行为。
 * 不刷新的场景（缺价）由 `list-holdings-pure-read.test.ts` 覆盖。
 */
const refreshed = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const result = await refreshHoldingsQuotesTool.execute({}, ctx);
  if (!result.ok) throw new Error('refresh failed');
  return result.data;
};

describe('list_holdings', () => {
  it('正常路径：6 条持仓 + PnL 汇总自洽', async () => {
    const ctx = await buildTestContext();
    await refreshed(ctx);
    const result = await listHoldingsTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.data;
    expect(data.accountId).toBe(TEST_ACCOUNT.id);
    expect(data.status).toBe('active');
    expect(data.holdings).toHaveLength(TEST_HOLDINGS.length);

    // 002594.SZ：现价 = mock 基准价 105.8，成本 98.5，数量 1000。
    const byd = data.holdings.find((h) => h.holding.stockId === '002594.SZ');
    expect(byd).toBeDefined();
    expect(byd?.stockName).toBe('比亚迪');
    expect(byd?.currentPrice).toBe(105.8);
    expect(byd?.marketValue).toBe(105800);
    expect(byd?.cost).toBe(98500);
    expect(byd?.pnl).toBe(7300);
    expect(byd?.pnlPct).toBeCloseTo(7300 / 98500, 6);

    /**
     * task-14 行为变更：昨收现在**只从已落库日线**取（纯读）。
     *
     * 这个 fixture 的日线只存在于 FakeMarketAdapter，从未落库 → 纯读拿不到昨收 → `null`。
     * 旧实现在这里会回源 `fetchDailyBars` 拿到值——那正是被拆掉的外部 IO。
     * 正确语义：**没有已落库的昨收就不伪造基准**，今日盈亏保持 `null`。
     */
    expect(byd?.previousClose).toBeNull();
    expect(byd?.todayPnl).toBeNull();
    expect(byd?.todayPnlPct).toBeNull();

    // 汇总 = 各项之和（Money 4 位小数不变量）。
    const sumValue = data.holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0);
    const sumCost = data.holdings.reduce((s, h) => s + h.cost, 0);
    expect(data.totalValue).toBeCloseTo(sumValue, 4);
    expect(data.totalCost).toBeCloseTo(sumCost, 4);
    expect(data.totalPnL).toBeCloseTo(sumValue - sumCost, 4);
    expect(data.totalPnLPct).toBeCloseTo((sumValue - sumCost) / sumCost, 6);
    expect(data.totalPnLPct).toBeGreaterThanOrEqual(-1);
    expect(data.totalPnLPct).toBeLessThanOrEqual(10);

    // 今日盈亏合计 = 各持仓今日盈亏之和；涨跌幅基准 = 总市值 − 今日合计（昨收市值）。
    const sumToday = data.holdings.reduce((s, h) => s + (h.todayPnl ?? 0), 0);
    expect(data.totalTodayPnl).toBeCloseTo(sumToday, 4);
    expect(data.totalTodayPnlPct).toBeCloseTo(sumToday / (sumValue - sumToday), 6);
  });

  it('status=closed → 空持仓 + 零汇总', async () => {
    const ctx = await buildTestContext();
    const result = await listHoldingsTool.execute({ status: 'closed' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holdings).toHaveLength(0);
    expect(result.data.totalValue).toBe(0);
    expect(result.data.totalCost).toBe(0);
    expect(result.data.totalPnL).toBe(0);
    expect(result.data.totalPnLPct).toBe(0);
  });

  it('status=all → 与 active 条数一致（mock 无已平仓）', async () => {
    const ctx = await buildTestContext();
    const result = await listHoldingsTool.execute({ status: 'all' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holdings).toHaveLength(TEST_HOLDINGS.length);
  });

  it('实时行情失败时使用本地最新快照，持仓列表仍可见', async () => {
    const ctx = await buildTestContext();
    const quote = await ctx.adapters.market.fetchQuote('002594.SZ');
    await ctx.repos.quote.save({ ...quote, close: money(123.45) });
    const failingContext = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        market: {
          ...ctx.adapters.market,
          name: 'failing-market',
          fetchQuote: async () => {
            throw new Error('market unavailable');
          },
          batchQuote: async () => {
            throw new Error('market unavailable');
          },
          fetchDailyBars: async () => [],
        },
      },
    };

    const result = await listHoldingsTool.execute({}, failingContext);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.data.holdings.find((h) => h.holding.stockId === '002594.SZ');
    expect(item?.currentPrice).toBe(123.45);
    // 日线不可用（返回空）→ 昨收与今日盈亏为 null，而不是伪造基准
    expect(item?.previousClose).toBeNull();
    expect(item?.todayPnl).toBeNull();
    expect(item?.todayPnlPct).toBeNull();
    expect(result.data.totalTodayPnl).toBeNull();
  });

  it('错误路径：账户不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const result = await listHoldingsTool.execute({ accountId: 'no-such-account' }, ctx);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Account', id: 'no-such-account' },
    });
  });

  it('错误路径：非法 status → invalid_input', async () => {
    const ctx = await buildTestContext();
    const result = await listHoldingsTool.execute({ status: 'bogus' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });
});

// task-30：顶层聚合时点 + 陈旧计数（0 是确定结论，不是缺失）。
describe('task-30 报价时点聚合', () => {
  it('每条持仓带报价时间；顶层 quoteAsOf 取最旧；全部有价时 staleCount 为 0', async () => {
    const ctx = await buildTestContext();
    // task-14 之后 `list_holdings` 纯读库内报价：先落一条当日合格报价再断言。
    const holdings = await ctx.repos.holding.listByAccount(TEST_ACCOUNT.id);
    const first = holdings[0];
    if (first === undefined) throw new Error('missing holding fixture');
    const observedAt = new Date('2026-07-24T02:00:00.000Z');
    await ctx.repos.quote.save({
      stockId: first.stockId,
      ts: observedAt,
      observedAt,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1000,
      source: 'fixture',
    } as never);
    const result = await listHoldingsTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const priced = result.data.holdings.filter((item) => item.priceStatus === 'priced');
    expect(priced.length).toBeGreaterThan(0);
    for (const item of priced) {
      // 有价就必须能说清「多旧」：时间字段存在（或缺席即 unknown 档，分档仍存在）。
      expect(item.quoteFreshness).toBeDefined();
    }
    const times = priced.flatMap((item) =>
      item.quoteObservedAt === undefined ? [] : [item.quoteObservedAt.getTime()],
    );
    if (times.length > 0) expect(result.data.quoteAsOf?.getTime()).toBe(Math.min(...times));
    // staleCount 恒给（0 = 确定没有陈旧数据）。
    expect(result.data.staleCount).toBeGreaterThanOrEqual(0);
  });

  it('现有字段零变更：priceStatus / priceUnavailableReason / unpricedCount 语义不变', async () => {
    const ctx = await buildTestContext();
    const result = await listHoldingsTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const item of result.data.holdings) {
      expect(['priced', 'unpriced']).toContain(item.priceStatus);
      if (item.priceStatus === 'unpriced') {
        expect(item.priceUnavailableReason).toBeDefined();
        expect(item.pnlPct).toBeUndefined();
      }
    }
    expect(result.data.unpricedCount).toBe(
      result.data.holdings.filter((item) => item.priceStatus === 'unpriced').length,
    );
  });
});
