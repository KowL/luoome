import { TEST_ACCOUNT, TEST_HOLDINGS } from '@luoome/adapters/testing';
import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { listHoldingsTool } from './list-holdings.js';

describe('list_holdings', () => {
  it('正常路径：6 条持仓 + PnL 汇总自洽', async () => {
    const ctx = await buildTestContext();
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

    // 汇总 = 各项之和（Money 4 位小数不变量）。
    const sumValue = data.holdings.reduce((s, h) => s + h.marketValue, 0);
    const sumCost = data.holdings.reduce((s, h) => s + h.cost, 0);
    expect(data.totalValue).toBeCloseTo(sumValue, 4);
    expect(data.totalCost).toBeCloseTo(sumCost, 4);
    expect(data.totalPnL).toBeCloseTo(sumValue - sumCost, 4);
    expect(data.totalPnLPct).toBeCloseTo((sumValue - sumCost) / sumCost, 6);
    expect(data.totalPnLPct).toBeGreaterThanOrEqual(-1);
    expect(data.totalPnLPct).toBeLessThanOrEqual(10);
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
    expect(
      result.data.holdings.find((item) => item.holding.stockId === '002594.SZ')?.currentPrice,
    ).toBe(123.45);
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
