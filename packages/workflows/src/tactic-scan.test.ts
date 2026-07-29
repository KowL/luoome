import type { Tactic } from '@luoome/core';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { tacticScanWorkflow } from './tactic-scan.js';

const makeAlwaysTactic = (index: number): Tactic => ({
  id: `scan-always-${String(index).padStart(2, '0')}`,
  name: `恒触发 ${index}`,
  tag: 'momentum',
  description: '测试用：持仓行情存在时恒触发',
  triggerWhen: 'quote.close > 0',
  scoreExpression: `${60 + index}`,
  direction: 'bullish',
  evidenceTemplate: [`恒触发 ${index}`],
  source: 'user',
  definedAt: new Date('2026-07-28T00:00:00.000Z'),
});

describe('workflow/tactic-scan', () => {
  it('all-stocks 缺少成功同步的 StockUniverse 时透传失败，不伪装为空结果', async () => {
    const ctx = await buildTestContext();

    const result = await tacticScanWorkflow.run(
      {
        tacticIds: ['breakout-volume'],
        scope: 'all-stocks',
        lookbackDays: 5,
        topN: 20,
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('原始信号超过 50 条时先确定性预选，再调用 LLM 精排', async () => {
    const ctx = await buildTestContext();
    const tactics = Array.from({ length: 30 }, (_, index) => makeAlwaysTactic(index));
    for (const tactic of tactics) {
      await ctx.repos.tactic.save(tactic);
    }

    const result = await tacticScanWorkflow.run(
      {
        tacticIds: tactics.map((tactic) => tactic.id),
        scope: 'holdings',
        lookbackDays: 5,
        topN: 20,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalSignals).toBeGreaterThan(50);
    expect(result.data.ranked).toHaveLength(20);
  });

  it('evaluatedStocks 统计实际求值股票，不等于命中或精排股票数', async () => {
    const ctx = await buildTestContext();
    const tactic: Tactic = {
      ...makeAlwaysTactic(99),
      id: 'scan-never-trigger',
      name: '永不触发',
      triggerWhen: 'quote.close < 0',
    };
    await ctx.repos.tactic.save(tactic);
    const holdings = await ctx.repos.holding.listByAccount(ctx.user.defaultAccountId);
    const expectedStocks = new Set(holdings.map((holding) => holding.stockId)).size;

    const result = await tacticScanWorkflow.run(
      {
        tacticIds: [tactic.id],
        scope: 'holdings',
        lookbackDays: 5,
        topN: 20,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalSignals).toBe(0);
    expect(result.data.ranked).toEqual([]);
    expect(result.data.evaluatedStocks).toBe(expectedStocks);
  });

  it('all-stocks 扫描透传实际 StockUniverse coverage 和 observedAt', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 2 });
    const tactic = makeAlwaysTactic(1);
    await ctx.repos.tactic.save(tactic);

    const result = await tacticScanWorkflow.run(
      {
        tacticIds: [tactic.id],
        scope: 'all-stocks',
        lookbackDays: 5,
        topN: 20,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.universe).toEqual({
      coverage: 'CN_A_SHARES_SH_SZ',
      observedAt: new Date('2026-07-28T08:00:00.000Z'),
      activeStocks: 2,
    });
  });
});
