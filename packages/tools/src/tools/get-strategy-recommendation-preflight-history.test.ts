import { STRATEGY_RECOMMENDATION_PREFLIGHT_REASON_ORDER } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { getStrategyRecommendationPreflightHistoryTool } from './get-strategy-recommendation-preflight-history.js';

const STRATEGY_ID = 'strategy-history-1';

const detail = (input: {
  readonly runId: string;
  readonly stockId: string;
  readonly status: 'eligible' | 'skipped' | 'unavailable';
  readonly reasonCodes?: readonly string[];
  readonly evaluatedAt: string;
  readonly factReferences?: readonly string[];
}) => ({
  accountId: 'account-private',
  strategyId: STRATEGY_ID,
  runId: input.runId,
  stockId: input.stockId,
  status: input.status,
  reasons: (input.reasonCodes ?? []).map((code) => ({ code, message: `reason:${code}` })),
  factReferences: [...(input.factReferences ?? ['fact-private'])],
  evaluatedAt: new Date(input.evaluatedAt),
  metrics: {},
});

const saveCycle = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  input: {
    readonly id: string;
    readonly startedAt: string;
    readonly status?: 'running' | 'succeeded' | 'partial' | 'failed';
    readonly strategyId?: string;
    readonly preflight?: unknown;
  },
): Promise<void> => {
  const status = input.status ?? 'succeeded';
  await ctx.repos.workflowRun.save({
    id: input.id,
    workflowName: 'strategy-daily-cycle',
    mode: 'scheduled',
    status,
    startedAt: new Date(input.startedAt),
    ...(status === 'running'
      ? {}
      : { finishedAt: new Date(new Date(input.startedAt).getTime() + 60_000) }),
    inputSummary: { strategyId: input.strategyId ?? STRATEGY_ID },
    ...(input.preflight === undefined ? {} : { outputSummary: { preflight: input.preflight } }),
    providerStatuses: [],
    ...(status === 'failed' ? { error: 'test failure' } : {}),
  });
};

describe('get_strategy_recommendation_preflight_history', () => {
  it('只聚合归属一致的终态快照，脱敏并稳定排序 reason/candidate', async () => {
    const ctx = await buildTestContext();
    const latestDetails = [
      detail({
        runId: 'cycle-latest',
        stockId: '600519.SH',
        status: 'skipped',
        reasonCodes: ['cooldown', 'exit-signal'],
        evaluatedAt: '2026-08-31T10:02:00.000Z',
      }),
      detail({
        runId: 'cycle-latest',
        stockId: '000001.SZ',
        status: 'eligible',
        evaluatedAt: '2026-08-31T10:01:00.000Z',
        factReferences: ['fact-one', 'fact-two'],
      }),
    ];
    await saveCycle(ctx, {
      id: 'cycle-latest',
      startedAt: '2026-08-31T10:00:00.000Z',
      preflight: {
        total: 2,
        eligible: 1,
        skipped: 1,
        unavailable: 0,
        details: latestDetails,
      },
    });
    await saveCycle(ctx, {
      id: 'cycle-earlier',
      startedAt: '2026-08-30T10:00:00.000Z',
      status: 'partial',
      preflight: {
        total: 1,
        eligible: 0,
        skipped: 0,
        unavailable: 1,
        details: [
          detail({
            runId: 'cycle-earlier',
            stockId: '300750.SZ',
            status: 'unavailable',
            reasonCodes: ['candidate-data-unavailable'],
            evaluatedAt: '2026-08-30T10:01:00.000Z',
          }),
        ],
      },
    });
    await saveCycle(ctx, {
      id: 'cycle-other-strategy',
      startedAt: '2026-08-29T10:00:00.000Z',
      strategyId: 'another-strategy',
      preflight: latestDetails,
    });
    await saveCycle(ctx, {
      id: 'cycle-corrupt',
      startedAt: '2026-08-28T10:00:00.000Z',
      preflight: { total: 1, details: 'not-an-array' },
    });
    await saveCycle(ctx, {
      id: 'cycle-legacy',
      startedAt: '2026-08-27T10:00:00.000Z',
    });
    await saveCycle(ctx, {
      id: 'cycle-running',
      startedAt: '2026-08-26T10:00:00.000Z',
      status: 'running',
    });

    const result = await getStrategyRecommendationPreflightHistoryTool.execute(
      { strategyId: STRATEGY_ID, limit: 10 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.runs.map((run) => run.startedAt.toISOString())).toEqual([
      '2026-08-31T10:00:00.000Z',
      '2026-08-30T10:00:00.000Z',
    ]);
    expect(result.data.runs[0]?.candidates.map((candidate) => candidate.stockId)).toEqual([
      '000001.SZ',
      '600519.SH',
    ]);
    expect(result.data.runs[0]?.candidates[1]).toMatchObject({
      status: 'skipped',
      reasonCodes: ['exit-signal', 'cooldown'],
      factCount: 1,
    });
    expect(result.data.reasonCounts).toEqual([
      { code: 'candidate-data-unavailable', count: 1 },
      { code: 'exit-signal', count: 1 },
      { code: 'cooldown', count: 1 },
    ]);
    expect(result.data.reasonCounts.map(({ code }) => code)).toEqual(
      STRATEGY_RECOMMENDATION_PREFLIGHT_REASON_ORDER.filter((code) =>
        result.data.reasonCounts.some((item) => item.code === code),
      ),
    );
    expect(result.data.limitations).toEqual([
      '旧运行没有 preflight 快照，已忽略。',
      '损坏的 preflight 快照未计入历史。',
    ]);
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain('account-private');
    expect(serialized).not.toContain('cycle-latest');
    expect(serialized).not.toContain('fact-private');
  });

  it('限制输出 runs 数量，并忽略计数不一致的旧快照', async () => {
    const ctx = await buildTestContext();
    await saveCycle(ctx, {
      id: 'cycle-bad-count',
      startedAt: '2026-08-31T10:00:00.000Z',
      preflight: {
        total: 2,
        eligible: 2,
        skipped: 0,
        unavailable: 0,
        details: [
          detail({
            runId: 'cycle-bad-count',
            stockId: '000001.SZ',
            status: 'eligible',
            evaluatedAt: '2026-08-31T10:01:00.000Z',
          }),
        ],
      },
    });
    await saveCycle(ctx, {
      id: 'cycle-good',
      startedAt: '2026-08-30T10:00:00.000Z',
      preflight: {
        total: 1,
        eligible: 1,
        skipped: 0,
        unavailable: 0,
        details: [
          detail({
            runId: 'cycle-good',
            stockId: '000001.SZ',
            status: 'eligible',
            evaluatedAt: '2026-08-30T10:01:00.000Z',
          }),
        ],
      },
    });
    for (let index = 0; index < 25; index += 1) {
      await saveCycle(ctx, {
        id: `cycle-without-preflight-${index}`,
        startedAt: `2026-08-31T09:${String(59 - index).padStart(2, '0')}:00.000Z`,
      });
    }

    const result = await getStrategyRecommendationPreflightHistoryTool.execute(
      { strategyId: STRATEGY_ID, limit: 1 },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        runs: [{ startedAt: new Date('2026-08-30T10:00:00.000Z') }],
        limitations: ['旧运行没有 preflight 快照，已忽略。', '损坏的 preflight 快照未计入历史。'],
      },
    });
  });
});
