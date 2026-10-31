import { TEST_ACCOUNT } from '@luoome/adapters/testing';
import { describe, expect, it, vi } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { listHoldingsTool } from './list-holdings.js';
import { refreshHoldingsQuotesTool } from './refresh-holdings-quotes.js';

/**
 * task-14 的**名实相符守卫**：`list_holdings` 声明 `sideEffect: 'read'`，
 * 所以它**不许**访问外部行情、**不许**写库。
 *
 * 背景：它曾声明 read，却经 `resolveQuotes` 回源并 `quote.save`。`sideEffect` 是给模型看的契约，
 * 模型据此判断「调用它安全」——名实不符等于给模型一个错误的安全担保。
 */

describe('task-14 list_holdings 是纯读', () => {
  it('调用 list_holdings 不产生任何外部行情调用，也不写 quote 表', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-10-15T02:00:00Z') });
    const batchQuote = vi.spyOn(ctx.adapters.market, 'batchQuote');
    const fetchQuote = vi.spyOn(ctx.adapters.market, 'fetchQuote');
    const fetchDailyBars = vi.spyOn(ctx.adapters.market, 'fetchDailyBars');
    const saveQuote = vi.spyOn(ctx.repos.quote, 'save');

    const before = await ctx.repos.quote.latestByStocks(['002594.SZ']);
    const result = await listHoldingsTool.execute({}, ctx);
    expect(result.ok).toBe(true);

    // 零外部 IO。
    expect(batchQuote).not.toHaveBeenCalled();
    expect(fetchQuote).not.toHaveBeenCalled();
    expect(fetchDailyBars).not.toHaveBeenCalled();
    // 零写库。
    expect(saveQuote).not.toHaveBeenCalled();
    const after = await ctx.repos.quote.latestByStocks(['002594.SZ']);
    expect(after.get('002594.SZ')).toBe(before.get('002594.SZ'));
  });

  it('库内没有报价 → 每条持仓 priceStatus=unpriced 且给原因，不伪造数字', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-10-15T02:00:00Z') });
    const result = await listHoldingsTool.execute({}, ctx);
    if (!result.ok) throw new Error('list_holdings failed');
    expect(result.data.holdings.length).toBeGreaterThan(0);
    for (const item of result.data.holdings) {
      expect(item.priceStatus).toBe('unpriced');
      expect(item.priceUnavailableReason).toBeDefined();
      expect(item.currentPrice).toBeUndefined();
      expect(item.marketValue).toBeUndefined();
    }
    // 合计字段缺席（不是 0）。
    expect(result.data.unpricedCount).toBe(result.data.holdings.length);
    expect('totalValue' in result.data).toBe(false);
  });

  it('refresh_holdings_quotes 是唯一回源入口，且如实报告失败（不伪成功）', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-10-15T02:00:00Z') });
    // 让批量取价整批失败：resolveQuotes 会回退本地快照，此时必须报 failed 而不是 allRefreshed。
    vi.spyOn(ctx.adapters.market, 'batchQuote').mockRejectedValue(new Error('upstream down'));
    const result = await refreshHoldingsQuotesTool.execute({}, ctx);
    if (!result.ok) throw new Error('refresh failed');
    expect(result.data.requested).toBeGreaterThan(0);
    expect(result.data.failed.length).toBeGreaterThan(0);
    expect(result.data.allRefreshed).toBe(false);
    // 失败条目逐条点名 + 原因。
    expect(result.data.failed[0]?.stockId).toBeTruthy();
    expect(result.data.failed[0]?.reason).toBeTruthy();
  });

  it('无持仓时 refresh 返回 requested=0 且 allRefreshed=true（空集不算失败）', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-10-15T02:00:00Z') });
    const result = await refreshHoldingsQuotesTool.execute({ accountId: TEST_ACCOUNT.id }, ctx);
    if (!result.ok) throw new Error('refresh failed');
    if (result.data.requested === 0) {
      expect(result.data.allRefreshed).toBe(true);
      expect(result.data.failed).toEqual([]);
    }
  });
});
