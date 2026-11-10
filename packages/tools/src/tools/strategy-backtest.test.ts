import type { StrategyDslV1 } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  createStrictStrategyBacktestTool,
  orderStrictBacktestTargetStockIds,
} from './strategy-backtest.js';
import { createStrategyTool, createStrategyVersionTool } from './strategy-lifecycle.js';

const NOW = new Date('2026-08-15T08:00:00.000Z');

const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: {},
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [{ id: 'positive', name: '价格有效', when: 'quote.close > 0', evidence: ['价格有效'] }],
  },
  signals: { entry: [], exit: [], risk: [] },
};

const costs = {
  commissionBps: 2.5,
  minimumCommission: 5,
  sellStampDutyBps: 5,
  buySlippageBps: 5,
  sellSlippageBps: 5,
};

const seedStrategy = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  id: string,
): Promise<string> => {
  const created = await createStrategyTool.execute(
    { id, name: `回测 ${id}`, description: 'strict backtest fixture' },
    ctx,
  );
  if (!created.ok) throw new Error('strategy fixture failed');
  const version = await createStrategyVersionTool.execute(
    { strategyId: id, definition, changeSummary: 'v1' },
    ctx,
  );
  if (!version.ok) throw new Error('strategy version fixture failed');
  return version.data.version.id;
};

describe('strict strategy backtest tools', () => {
  it('按 rank 升序、stockId 升序构造稳定目标顺序，不按代码抢占高排名', () => {
    const result = (stockId: string, rank?: number) => ({
      runId: 'run-order',
      stockId,
      selected: true,
      ...(rank === undefined ? {} : { rank }),
      ruleEvaluations: [],
      evidence: [],
      dataAsOf: NOW,
    });

    expect(
      orderStrictBacktestTargetStockIds([
        result('000001.SZ', 2),
        result('600519.SH', 1),
        result('300001.SZ'),
        result('000002.SZ'),
      ]),
    ).toEqual(['600519.SH', '000001.SZ', '000002.SZ', '300001.SZ']);
  });

  it('未知 Strategy/版本返回 not_found，跨 Strategy 版本返回 invalid_input', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const versionId = await seedStrategy(ctx, 'strict-strategy');
    const otherVersionId = await seedStrategy(ctx, 'strict-other');

    const missingStrategy = await createStrictStrategyBacktestTool.execute(
      { strategyId: 'no-such-strategy', strategyVersionId: versionId, from: NOW, to: NOW, costs },
      ctx,
    );
    expect(missingStrategy).toMatchObject({ ok: false, error: { kind: 'not_found' } });

    const missingVersion = await createStrictStrategyBacktestTool.execute(
      {
        strategyId: 'strict-strategy',
        strategyVersionId: 'no-such-version',
        from: NOW,
        to: NOW,
        costs,
      },
      ctx,
    );
    expect(missingVersion).toMatchObject({ ok: false, error: { kind: 'not_found' } });

    const foreignVersion = await createStrictStrategyBacktestTool.execute(
      {
        strategyId: 'strict-strategy',
        strategyVersionId: otherVersionId,
        from: NOW,
        to: NOW,
        costs,
      },
      ctx,
    );
    expect(foreignVersion).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });

  it('无可回测运行时不输出收益指标，也不写交易或建议', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const versionId = await seedStrategy(ctx, 'strict-strategy');
    const tradesBefore = await ctx.repos.trade.listByAccount(ctx.user.defaultAccountId);
    const advicesBefore = await ctx.repos.advice.query({ includeExpired: true });

    const result = await createStrictStrategyBacktestTool.execute(
      {
        strategyId: 'strict-strategy',
        strategyVersionId: versionId,
        from: new Date('2026-08-10T00:00:00.000Z'),
        to: new Date('2026-08-14T00:00:00.000Z'),
        costs,
      },
      ctx,
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.data.run.spec.schemaVersion).toBe(2);
    expect(result.data.run.resultAvailability).not.toBe('complete');
    expect(result.data.run.metrics).toBeUndefined();
    expect(result.data.run.gateAudit.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'pit-universe', status: 'unavailable' }),
        expect.objectContaining({ key: 'evaluator-code', status: 'unavailable' }),
      ]),
    );
    expect(await ctx.repos.trade.listByAccount(ctx.user.defaultAccountId)).toEqual(tradesBefore);
    expect(await ctx.repos.advice.query({ includeExpired: true })).toEqual(advicesBefore);
  });

  it('费用/滑点参数必须显式完整，不能用隐含零值或负值', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const versionId = await seedStrategy(ctx, 'strict-strategy');
    const result = await createStrictStrategyBacktestTool.execute(
      {
        strategyId: 'strict-strategy',
        strategyVersionId: versionId,
        from: NOW,
        to: NOW,
        costs: { ...costs, commissionBps: -1 },
      },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });
});
