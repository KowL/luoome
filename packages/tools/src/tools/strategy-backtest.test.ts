import { type StrategyEvaluationSession, strategyDefinitionHash } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { createStrictStrategyBacktestTool } from './strategy-backtest.js';

const NOW = new Date('2026-08-15T08:00:00.000Z');

const session: StrategyEvaluationSession = {
  id: 'strict-evaluation-session',
  strategyId: 'strict-strategy',
  strategyVersionId: 'strict-strategy-v1',
  from: new Date('2026-08-13T00:00:00.000Z'),
  to: new Date('2026-08-14T00:00:00.000Z'),
  status: 'complete',
  definitionHash: strategyDefinitionHash({
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: { logic: 'all', rules: [] },
    signals: { entry: [], exit: [], risk: [] },
  }),
  createdAt: new Date('2026-08-12T00:00:00.000Z'),
  finishedAt: new Date('2026-08-15T00:00:00.000Z'),
};

describe('strict strategy backtest tools', () => {
  it('真实事实门禁缺失时保存 partial 审计且不输出任何收益指标', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.strategyEvaluation.saveSession(session);
    const tradesBefore = await ctx.repos.trade.listByAccount(ctx.user.defaultAccountId);
    const result = await createStrictStrategyBacktestTool.execute(
      {
        strategyId: session.strategyId,
        evaluationSessionId: session.id,
        costs: {
          commissionBps: 2.5,
          minimumCommission: 5,
          sellStampDutyBps: 5,
          buySlippageBps: 5,
          sellSlippageBps: 5,
        },
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        run: {
          status: 'complete',
          resultAvailability: 'partial',
        },
      },
    });
    if (result.ok) {
      expect(result.data.run.metrics).toBeUndefined();
      expect(result.data.run.gateAudit.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'tradability', status: 'complete' }),
          expect.objectContaining({ key: 'daily-bar-revisions', status: 'unavailable' }),
          expect.objectContaining({ key: 'evaluator-code', status: 'unavailable' }),
        ]),
      );
    }
    expect(await ctx.repos.trade.listByAccount(ctx.user.defaultAccountId)).toEqual(tradesBefore);
    expect(await ctx.repos.advice.query({ includeExpired: true })).toHaveLength(2);
  });

  it('费用/滑点参数必须显式完整，不能用隐含零值', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.strategyEvaluation.saveSession(session);
    const result = await createStrictStrategyBacktestTool.execute(
      {
        strategyId: session.strategyId,
        evaluationSessionId: session.id,
        costs: {
          commissionBps: -1,
          minimumCommission: 5,
          sellStampDutyBps: 5,
          buySlippageBps: 5,
          sellSlippageBps: 5,
        },
      },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });
});
