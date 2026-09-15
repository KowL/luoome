import { money, reconcileCashBalance } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { reconcileAccountCashTool } from './account-facts.js';
import { addHoldingTool } from './add-holding.js';
import { addTradeTool } from './add-trade.js';
import { closeHoldingTool } from './close-holding.js';
import { createPortfolioCashFlowTool } from './portfolio-performance.js';
import { updateHoldingTool } from './update-holding.js';

/**
 * 账户现金随账本变化：余额字段由写路径与交易/持仓/流水同事务更新，
 * 每次写入后都必须能与账本重算对齐（差额 0）。
 */

const accountOf = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const account = await ctx.repos.account.findById(ctx.user.defaultAccountId);
  if (account === null) throw new Error('fixture account missing');
  return account;
};

const assertReconciled = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const account = await accountOf(ctx);
  const [holdings, trades, cashFlows] = await Promise.all([
    ctx.repos.holding.listByAccount(account.id),
    ctx.repos.trade.listByAccount(account.id),
    ctx.repos.portfolioCashFlow.listByAccount(account.id),
  ]);
  const result = reconcileCashBalance(account, {
    account,
    holdings,
    trades,
    cashFlows,
  });
  // 直接登记的持仓本来就没有交易记录（uncovered>0 是预期），
  // 但「净买入多于持仓」和「净卖出」这两类缺口属于账本不一致，必须为空。
  expect({
    difference: result.difference,
    unexpected: result.gaps.filter(
      (gap) => gap.unmatchedTradeQuantity > 0 || gap.oversoldQuantity > 0,
    ),
  }).toEqual({ difference: 0, unexpected: [] });
  return account;
};

describe('账户现金随账本变化', () => {
  it('买入按成交价扣现金、卖出加现金（不计手续费），且字段与账本始终对齐', async () => {
    const ctx = await buildTestContext();
    const before = (await accountOf(ctx)).cashBalance;

    const bought = await addTradeTool.execute(
      { stockId: '601398.SH', side: 'buy', quantity: 100, price: 10, fee: 999 },
      ctx,
    );
    expect(bought.ok).toBe(true);
    // 手续费只作记录，不进现金
    expect((await accountOf(ctx)).cashBalance).toBe(before - 1000);
    await assertReconciled(ctx);

    const sold = await addTradeTool.execute(
      { stockId: '600519.SH', side: 'sell', quantity: 10, price: 1500 },
      ctx,
    );
    expect(sold.ok).toBe(true);
    expect((await accountOf(ctx)).cashBalance).toBe(before - 1000 + 15_000);
    await assertReconciled(ctx);
  });

  it('直接登记持仓按成本扣现金；平仓按成本回补', async () => {
    const ctx = await buildTestContext();
    const before = (await accountOf(ctx)).cashBalance;

    const added = await addHoldingTool.execute(
      { stockId: '601398.SH', quantity: 500, avgCost: 8 },
      ctx,
    );
    expect(added.ok).toBe(true);
    expect((await accountOf(ctx)).cashBalance).toBe(before - 4000);
    await assertReconciled(ctx);

    const closed = await closeHoldingTool.execute(
      { holdingId: added.ok ? added.data.holding.id : '' },
      ctx,
    );
    expect(closed.ok).toBe(true);
    expect((await accountOf(ctx)).cashBalance).toBe(before);
    await assertReconciled(ctx);
  });

  it('纠错持仓数量时按成本差额回补现金', async () => {
    const ctx = await buildTestContext();
    const added = await addHoldingTool.execute(
      { stockId: '601398.SH', quantity: 500, avgCost: 8 },
      ctx,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const afterBuy = (await accountOf(ctx)).cashBalance;

    const corrected = await updateHoldingTool.execute(
      { holdingId: added.data.holding.id, quantity: 300, availableQuantity: 300 },
      ctx,
    );
    expect(corrected.ok).toBe(true);
    expect((await accountOf(ctx)).cashBalance).toBe(afterBuy + 200 * 8);
    await assertReconciled(ctx);
  });

  it('资金流水增减现金：入金加、出金减', async () => {
    const ctx = await buildTestContext();
    const before = (await accountOf(ctx)).cashBalance;

    const deposit = await createPortfolioCashFlowTool.execute(
      {
        accountId: ctx.user.defaultAccountId,
        occurredAt: new Date(),
        kind: 'deposit',
        amount: 50_000,
      },
      ctx,
    );
    expect(deposit.ok).toBe(true);
    expect((await accountOf(ctx)).cashBalance).toBe(before + 50_000);
    await assertReconciled(ctx);

    const withdrawal = await createPortfolioCashFlowTool.execute(
      {
        accountId: ctx.user.defaultAccountId,
        occurredAt: new Date(),
        kind: 'withdrawal',
        amount: 20_000,
      },
      ctx,
    );
    expect(withdrawal.ok).toBe(true);
    expect((await accountOf(ctx)).cashBalance).toBe(before + 30_000);
    await assertReconciled(ctx);
  });

  it('现金不足时拒绝买入，且不留下半写状态（无交易、无持仓变化）', async () => {
    const ctx = await buildTestContext();
    const before = await accountOf(ctx);
    const tradesBefore = await ctx.repos.trade.listByAccount(before.id);

    const result = await addTradeTool.execute(
      {
        stockId: '601398.SH',
        side: 'buy',
        quantity: 1_000_000,
        price: 10,
      },
      ctx,
    );
    expect(result.ok).toBe(false);

    const after = await accountOf(ctx);
    expect(after.cashBalance).toBe(before.cashBalance);
    expect(await ctx.repos.trade.listByAccount(before.id)).toHaveLength(tradesBefore.length);
    expect(await ctx.repos.holding.findByAccountAndStock(before.id, '601398.SH')).toBeNull();
  });

  it('出金超过余额时拒绝，余额不变', async () => {
    const ctx = await buildTestContext();
    const before = (await accountOf(ctx)).cashBalance;

    const result = await createPortfolioCashFlowTool.execute(
      {
        accountId: ctx.user.defaultAccountId,
        occurredAt: new Date(),
        kind: 'withdrawal',
        amount: before + 1,
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect((await accountOf(ctx)).cashBalance).toBe(before);
  });
});

describe('账户现金对账工具', () => {
  it('账本与现金字段一致时 reconciled=true，差额为 0', async () => {
    const ctx = await buildTestContext();
    const added = await addTradeTool.execute(
      { stockId: '601398.SH', side: 'buy', quantity: 100, price: 10, fee: 0 },
      ctx,
    );
    expect(added.ok).toBe(true);
    const result = await reconcileAccountCashTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.reconciled).toBe(true);
    expect(result.data.difference).toBe(0);
    expect(result.data.gaps).toEqual([]);
  });

  it('人为改错现金后能报出差额（漏记资金）', async () => {
    const ctx = await buildTestContext();
    const account = await accountOf(ctx);
    await ctx.repos.account.save({ ...account, cashBalance: money(account.cashBalance - 500) });
    const result = await reconcileAccountCashTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.reconciled).toBe(false);
    expect(result.data.difference).toBe(-500);
  });
});
