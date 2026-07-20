import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { addTradeTool } from './add-trade.js';
import { analyzePositionTool } from './analyze-position.js';

describe('add_trade', () => {
  it('buy 新开仓：落 trade + holding（avgCost=price）+ 自动补 stock stub', async () => {
    const ctx = await buildMockContext();
    // 601398.SH 不在 fixtures 中
    const result = await addTradeTool.execute(
      { stockId: '601398.SH', side: 'buy', quantity: 500, price: 70.25, fee: 3.5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.trade.source).toBe('manual');
    expect(result.data.trade.side).toBe('buy');
    expect(result.data.holding.quantity).toBe(500);
    expect(result.data.holding.availableQuantity).toBe(500);
    expect(result.data.holding.avgCost).toBe(70.25);
    expect(result.data.holding.closedAt).toBeNull();

    // stock stub 生效：analyze_position 不因缺 stock 行而 not_found
    const stock = await ctx.repos.stock.findById('601398.SH');
    expect(stock?.code).toBe('601398');
    expect(stock?.exchange).toBe('SH');
  });

  it('buy 加仓：avgCost 数量加权（不含 fee），数量/可卖累加', async () => {
    const ctx = await buildMockContext();
    // fixtures: mock-holding-002594 1000 @ 98.5
    const result = await addTradeTool.execute(
      { stockId: '002594.SZ', side: 'buy', quantity: 1000, price: 108.5, fee: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holding.quantity).toBe(2000);
    expect(result.data.holding.availableQuantity).toBe(2000);
    expect(result.data.holding.avgCost).toBe(103.5);
  });

  it('sell 部分减仓：数量/可卖减少，avgCost 不变，closedAt 仍为 null', async () => {
    const ctx = await buildMockContext();
    const result = await addTradeTool.execute(
      { stockId: '002594.SZ', side: 'sell', quantity: 400, price: 110 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holding.quantity).toBe(600);
    expect(result.data.holding.availableQuantity).toBe(600);
    expect(result.data.holding.avgCost).toBe(98.5);
    expect(result.data.holding.closedAt).toBeNull();
  });

  it('sell 清仓：quantity=0 → closedAt=executedAt', async () => {
    const ctx = await buildMockContext();
    const executedAt = new Date('2026-07-20T06:00:00.000Z');
    const result = await addTradeTool.execute(
      { stockId: '600519.SH', side: 'sell', quantity: 100, price: 1500, executedAt },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holding.quantity).toBe(0);
    expect(result.data.holding.closedAt?.toISOString()).toBe(executedAt.toISOString());
  });

  it('清仓后重新买入：复用旧行 id 重新开仓', async () => {
    const ctx = await buildMockContext();
    const sell = await addTradeTool.execute(
      { stockId: '600519.SH', side: 'sell', quantity: 100, price: 1500 },
      ctx,
    );
    expect(sell.ok).toBe(true);
    if (!sell.ok) return;
    const closedId = sell.data.holding.id;

    const rebuy = await addTradeTool.execute(
      { stockId: '600519.SH', side: 'buy', quantity: 50, price: 1400 },
      ctx,
    );
    expect(rebuy.ok).toBe(true);
    if (!rebuy.ok) return;
    expect(rebuy.data.holding.id).toBe(closedId);
    expect(rebuy.data.holding.quantity).toBe(50);
    expect(rebuy.data.holding.avgCost).toBe(1400);
    expect(rebuy.data.holding.closedAt).toBeNull();
  });

  it('sell 超卖 → invalid_input', async () => {
    const ctx = await buildMockContext();
    const result = await addTradeTool.execute(
      { stockId: '002594.SZ', side: 'sell', quantity: 9999, price: 110 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('sell 无持仓 → invalid_input', async () => {
    const ctx = await buildMockContext();
    const result = await addTradeTool.execute(
      { stockId: '601398.SH', side: 'sell', quantity: 100, price: 70 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('账户不存在 → not_found', async () => {
    const ctx = await buildMockContext();
    const result = await addTradeTool.execute(
      { stockId: '601398.SH', side: 'buy', quantity: 100, price: 70, accountId: 'no-such' },
      ctx,
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Account', id: 'no-such' },
    });
  });

  it('stockId 缺交易所后缀 → invalid_input（schema）', async () => {
    const ctx = await buildMockContext();
    const result = await addTradeTool.execute(
      { stockId: '601398', side: 'buy', quantity: 100, price: 70 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('联动：新开仓后 analyze_position 可用（stock stub 生效）', async () => {
    const ctx = await buildMockContext();
    const added = await addTradeTool.execute(
      { stockId: '601398.SH', side: 'buy', quantity: 500, price: 70.25 },
      ctx,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const analyzed = await analyzePositionTool.execute({ holdingId: added.data.holding.id }, ctx);
    expect(analyzed.ok).toBe(true);
  });
});
