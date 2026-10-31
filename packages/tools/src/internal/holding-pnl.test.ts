import { type Holding, money, type Quote } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { enrichHolding, HOLDING_PRICE_UNAVAILABLE, summarizePnl } from './holding-pnl.js';

const holding = (overrides: Partial<Holding> = {}): Holding =>
  ({
    id: 'holding-1',
    accountId: 'account-a',
    stockId: '600519.SH',
    quantity: 100,
    availableQuantity: 100,
    avgCost: money(10),
    openedAt: new Date('2026-07-01T00:00:00.000Z'),
    closedAt: null,
    ...overrides,
  }) as Holding;

const quote = (close: number): Quote =>
  ({
    stockId: '600519.SH',
    ts: new Date('2026-07-29T02:00:00.000Z'),
    open: money(close),
    high: money(close),
    low: money(close),
    close: money(close),
    volume: 1000,
    source: 'fixture',
  }) as Quote;

describe('REQ-M3-09 缺价诚实化', () => {
  // 核心验收：缺价时不出现任何百分比数字，且披露原因。
  it('omits every price-derived number when the quote is missing', () => {
    const item = enrichHolding(holding(), undefined, '贵州茅台');
    expect(item.priceStatus).toBe('unpriced');
    expect(item.priceUnavailableReason).toBe(HOLDING_PRICE_UNAVAILABLE);
    expect(item.priceUnavailableReason).toContain('缺价');
    // 字段**缺席**（不是 0、不是 null）。
    expect('pnlPct' in item).toBe(false);
    expect('pnl' in item).toBe(false);
    expect('marketValue' in item).toBe(false);
    expect('currentPrice' in item).toBe(false);
    expect(item.pnlPct).toBeUndefined();
    // 成本价没有被拿来顶替现价。
    expect(JSON.stringify(item)).not.toContain('"currentPrice":10');
    // 今日盈亏不伪造基准。
    expect(item.todayPnl).toBeNull();
    expect(item.todayPnlPct).toBeNull();
  });

  // 反向：真实 0 盈亏（有价、成本等于市值）必须仍然显示 0，而不是被当成缺价。
  it('keeps a genuine zero pnl when the quote exists', () => {
    const item = enrichHolding(holding(), quote(10), '贵州茅台', money(10));
    expect(item.priceStatus).toBe('priced');
    expect(item.pnlPct).toBe(0);
    expect('pnlPct' in item).toBe(true);
    expect(item.pnl).toBe(0);
    expect(item.todayPnl).toBe(0);
  });

  // 汇总：任一持仓缺价 → 合计字段缺席，而不是把已定价部分冒充全量。
  it('omits totals when any holding is unpriced', () => {
    const priced = enrichHolding(holding(), quote(12), 'A');
    const unpriced = enrichHolding(holding({ id: 'holding-2' }), undefined, 'B');
    const summary = summarizePnl([priced, unpriced]);
    expect(summary.unpricedCount).toBe(1);
    expect('totalValue' in summary).toBe(false);
    expect('totalPnL' in summary).toBe(false);
    expect('totalPnLPct' in summary).toBe(false);
    expect(summary.totalTodayPnl).toBeNull();
  });

  it('keeps totals when every holding is priced', () => {
    const summary = summarizePnl([
      enrichHolding(holding(), quote(12), 'A'),
      enrichHolding(holding({ id: 'h2' }), quote(8), 'B'),
    ]);
    expect(summary.unpricedCount).toBe(0);
    expect(summary.totalValue).toBe(2000);
    expect(summary.totalCost).toBe(2000);
    expect(summary.totalPnL).toBe(0);
    // 零盈亏是事实：合计为 0，而不是缺席。
    expect(summary.totalPnLPct).toBe(0);
  });
});

// task-30：报价时间与时效分档（**与缺价正交**）。
describe('task-30 报价时点', () => {
  const quoteAt = (at: Date): Quote =>
    ({
      stockId: '600519.SH',
      ts: at,
      observedAt: at,
      open: money(10),
      high: money(10),
      low: money(10),
      close: money(10),
      volume: 1000,
      source: 'fixture',
    }) as Quote;
  const tradingNow = new Date('2026-11-02T02:00:00.000Z'); // 周一 10:00 上海（盘中）
  const yesterdayClose = new Date('2026-10-30T07:00:00.000Z'); // 上一交易日 15:00

  it('有价时输出 quoteObservedAt 与分档；当日 = live', () => {
    const today = new Date('2026-11-02T01:30:00.000Z');
    const item = enrichHolding(holding(), quoteAt(today), 'A', null, undefined, {
      now: tradingNow,
      session: 'trading',
    });
    expect(item.priceStatus).toBe('priced');
    expect(item.quoteObservedAt?.toISOString()).toBe(today.toISOString());
    expect(item.quoteFreshness?.tier).toBe('live');
  });

  // ② 核心验收：同一份昨日数据，盘前 factual / 盘中 warning。
  it('同一份上一交易日数据：盘前 factual、盘中 warning（依赖 marketSession，不是靠日期蒙对）', () => {
    const preOpen = enrichHolding(holding(), quoteAt(yesterdayClose), 'A', null, undefined, {
      now: tradingNow,
      session: 'pre-open',
    });
    expect(preOpen.quoteFreshness?.tier).toBe('prior-session');
    expect(preOpen.quoteFreshness?.tone).toBe('factual');

    const trading = enrichHolding(holding(), quoteAt(yesterdayClose), 'A', null, undefined, {
      now: tradingNow,
      session: 'trading',
    });
    expect(trading.quoteFreshness?.tier).toBe('stale');
    expect(trading.quoteFreshness?.tone).toBe('warning');
  });

  // ① 时间缺失 ≠ 价格缺失：有价但不知多旧 → unknown（仍 priced）。
  it('有价但没有观测时间 → priced + unknown（不是 unpriced、不是 live）', () => {
    const noTime = { ...(quoteAt(tradingNow) as unknown as Record<string, unknown>) };
    delete noTime.observedAt;
    const item = enrichHolding(holding(), noTime as unknown as Quote, 'A', null, undefined, {
      now: tradingNow,
      session: 'trading',
    });
    expect(item.priceStatus).toBe('priced');
    expect(item.quoteObservedAt).toBeUndefined();
    expect(item.quoteFreshness?.tier).toBe('unknown');
    expect(item.quoteFreshness?.tone).toBe('warning');
  });
});
