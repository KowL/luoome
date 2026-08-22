import { type StrategyDslV1, type StrategyVersion, strategyDefinitionHash } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { addTradeTool } from './add-trade.js';
import { analyzePositionTool } from './analyze-position.js';
import { listTradesTool } from './list-trades.js';

describe('add_trade', () => {
  it('接受显式 Advice / ResearchHypothesisVersion / StrategyVersion 归因并可按归因查询', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    const advice = (
      await ctx.repos.advice.query({
        subjectKind: 'stock',
        subjectId: '002594.SZ',
        includeExpired: true,
      })
    )[0];
    if (advice === undefined) throw new Error('test advice missing');

    await ctx.repos.researchHypothesisVersion.create({
      id: 'hypothesis_trade-test',
      topicId: 'topic_trade-test',
      documentId: 'doc_trade-test',
      documentContentHash: 'a'.repeat(64),
      version: 1,
      status: 'active',
      createdAt: now,
    });
    const definition: StrategyDslV1 = {
      schemaVersion: 1,
      metadata: { horizon: 'short' },
      universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
      selection: {
        logic: 'all',
        rules: [{ id: 'rule', name: '有效价格', when: 'quote.close > 0', evidence: ['价格'] }],
      },
      signals: { entry: [], exit: [], risk: [] },
    };
    const strategyVersion: StrategyVersion = {
      id: 'trade-strategy-v1',
      strategyId: 'trade-strategy',
      version: 1,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      publishedAt: now,
      createdAt: now,
    };
    await ctx.repos.strategy.create({
      id: 'trade-strategy',
      name: '交易归因策略',
      description: '测试用策略',
      owner: 'user',
      status: 'active',
      currentVersionId: strategyVersion.id,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.repos.strategy.createVersion(strategyVersion);

    const result = await addTradeTool.execute(
      {
        stockId: '002594.SZ',
        side: 'buy',
        quantity: 100,
        price: 106,
        adviceId: advice.id,
        researchHypothesisVersionId: 'hypothesis_trade-test',
        strategyVersionId: strategyVersion.id,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.trade).toMatchObject({
      adviceId: advice.id,
      researchHypothesisVersionId: 'hypothesis_trade-test',
      strategyVersionId: strategyVersion.id,
    });

    const listed = await listTradesTool.execute({ adviceId: advice.id }, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.trades.map((trade) => trade.id)).toContain(result.data.trade.id);
  });

  it('拒绝 Advice 股票不一致、缺失假设版本和未发布 StrategyVersion', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    const wrongAdvice = (
      await ctx.repos.advice.query({
        subjectKind: 'stock',
        subjectId: '600519.SH',
        includeExpired: true,
      })
    )[0];
    if (wrongAdvice === undefined) throw new Error('test advice missing');

    const mismatched = await addTradeTool.execute(
      {
        stockId: '002594.SZ',
        side: 'buy',
        quantity: 100,
        price: 106,
        adviceId: wrongAdvice.id,
      },
      ctx,
    );
    expect(mismatched).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });

    const missingHypothesis = await addTradeTool.execute(
      {
        stockId: '002594.SZ',
        side: 'buy',
        quantity: 100,
        price: 106,
        researchHypothesisVersionId: 'hypothesis_missing',
      },
      ctx,
    );
    expect(missingHypothesis).toMatchObject({ ok: false, error: { kind: 'not_found' } });

    const definition: StrategyDslV1 = {
      schemaVersion: 1,
      metadata: {},
      universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
      selection: {
        logic: 'all',
        rules: [{ id: 'rule', name: '有效价格', when: 'quote.close > 0', evidence: ['价格'] }],
      },
      signals: { entry: [], exit: [], risk: [] },
    };
    await ctx.repos.strategy.create({
      id: 'unpublished-trade-strategy',
      name: '未发布策略',
      description: '测试用策略',
      owner: 'user',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });
    await ctx.repos.strategy.createVersion({
      id: 'unpublished-trade-v1',
      strategyId: 'unpublished-trade-strategy',
      version: 1,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      createdAt: now,
    });
    const unpublished = await addTradeTool.execute(
      {
        stockId: '002594.SZ',
        side: 'buy',
        quantity: 100,
        price: 106,
        strategyVersionId: 'unpublished-trade-v1',
      },
      ctx,
    );
    expect(unpublished).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });

  it('buy 新开仓：落 trade + holding（avgCost=price）+ 自动补 stock stub', async () => {
    const ctx = await buildTestContext();
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

  it('buy 新开仓时保留搜索结果中的股票名称', async () => {
    const ctx = await buildTestContext();
    const result = await addTradeTool.execute(
      {
        stockId: '601398.SH',
        stockName: '工商银行',
        side: 'buy',
        quantity: 500,
        price: 7.25,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect((await ctx.repos.stock.findById('601398.SH'))?.name).toBe('工商银行');
  });

  it('buy 加仓：avgCost 数量加权（不含 fee），数量/可卖累加', async () => {
    const ctx = await buildTestContext();
    // fixtures: test-holding-002594 1000 @ 98.5
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
    const ctx = await buildTestContext();
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
    const ctx = await buildTestContext();
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
    const ctx = await buildTestContext();
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
    const ctx = await buildTestContext();
    const before = await ctx.repos.trade.listByAccount(ctx.user.defaultAccountId);
    const result = await addTradeTool.execute(
      { stockId: '002594.SZ', side: 'sell', quantity: 9999, price: 110 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect(await ctx.repos.trade.listByAccount(ctx.user.defaultAccountId)).toEqual(before);
  });

  it('sell 无持仓 → invalid_input', async () => {
    const ctx = await buildTestContext();
    const before = await ctx.repos.trade.listByAccount(ctx.user.defaultAccountId);
    const result = await addTradeTool.execute(
      { stockId: '601398.SH', side: 'sell', quantity: 100, price: 70 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect(await ctx.repos.trade.listByAccount(ctx.user.defaultAccountId)).toEqual(before);
  });

  it('账户不存在 → not_found', async () => {
    const ctx = await buildTestContext();
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
    const ctx = await buildTestContext();
    const result = await addTradeTool.execute(
      { stockId: '601398', side: 'buy', quantity: 100, price: 70 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('联动：新开仓后 analyze_position 可用（stock stub 生效）', async () => {
    const ctx = await buildTestContext();
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
