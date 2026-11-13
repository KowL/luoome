import {
  type Strategy,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import { backfillStrategyObservationCandidatesTool } from './backfill-strategy-observation-candidates.js';
import { runStrategyTool } from './run-strategy.js';

const NOW = new Date('2026-07-28T09:00:00Z');
const STOCK_ID = '600519.SH';

const seedStrategy = async (ctx: Awaited<ReturnType<typeof buildTestContext>>): Promise<void> => {
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: {
      logic: 'all',
      rules: [
        {
          id: 'positive-price',
          name: '价格有效',
          when: 'quote.close > 0',
          evidence: ['价格有效'],
        },
      ],
    },
    signals: {
      entry: [
        {
          id: 'entry',
          name: '研究信号',
          when: 'quote.close > 0',
          score: '60',
          direction: 'bullish',
          evidence: ['仅供研究'],
        },
      ],
      exit: [],
      risk: [],
    },
  };
  const version: StrategyVersion = {
    id: 'backfill-strategy-v1',
    strategyId: 'backfill-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: NOW,
    createdAt: NOW,
  };
  const strategy: Strategy = {
    id: 'backfill-strategy',
    name: '回填策略',
    description: '观察回填测试',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await ctx.repos.strategy.create(strategy);
  await ctx.repos.strategy.createVersion(version);
};

const setup = async (): Promise<Awaited<ReturnType<typeof buildTestContext>>> => {
  const ctx = await buildTestContext({ clock: () => NOW });
  await seedTestStockUniverse(ctx, { limit: 1 });
  await seedStrategy(ctx);
  return ctx;
};

const publishRun = async (ctx: Awaited<ReturnType<typeof buildTestContext>>): Promise<string> => {
  const run = await runStrategyTool.execute(
    { strategyId: 'backfill-strategy', persist: true },
    ctx,
  );
  expect(run.ok).toBe(true);
  if (!run.ok) throw new Error(run.error.kind);
  expect(run.data.run.publication?.status).toBe('published');
  return run.data.run.id;
};

describe('backfill_strategy_observation_candidates', () => {
  it('批量补建 published operational run，重复执行幂等', async () => {
    const ctx = await setup();
    await publishRun(ctx);
    await publishRun(ctx);
    const evaluation = await runStrategyTool.execute(
      { strategyId: 'backfill-strategy', stockIds: [STOCK_ID], persist: true },
      ctx,
    );
    expect(evaluation.ok).toBe(true);

    const first = await backfillStrategyObservationCandidatesTool.execute({ limit: 10 }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data).toMatchObject({
      scanned: 2,
      eligible: 2,
      created: 6,
      skipped: 0,
      failed: 0,
      truncated: false,
    });
    expect(first.data.runs).toHaveLength(2);
    expect(first.data.runs.every((run) => run.status === 'created')).toBe(true);

    const again = await backfillStrategyObservationCandidatesTool.execute({ limit: 10 }, ctx);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data).toMatchObject({ created: 0, skipped: 6, failed: 0 });
    expect(again.data.runs.every((run) => run.status === 'skipped')).toBe(true);
  });

  it('limit 截断时提示继续分页的范围', async () => {
    const ctx = await setup();
    await publishRun(ctx);
    await publishRun(ctx);

    const result = await backfillStrategyObservationCandidatesTool.execute({ limit: 1 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ scanned: 1, eligible: 1, truncated: true });
    expect(result.data.oldestStartedAt).toBeInstanceOf(Date);
    expect(result.data.warnings.some((warning) => warning.includes('limit=1'))).toBe(true);
  });

  it('单个 run 创建失败时记录失败并继续处理其他 run', async () => {
    const ctx = await setup();
    await publishRun(ctx);
    await publishRun(ctx);
    const failingRepo = Object.create(
      ctx.repos.signalObservation,
    ) as typeof ctx.repos.signalObservation;
    failingRepo.save = async () => {
      throw new Error('observation store unavailable');
    };
    const failingCtx = {
      ...ctx,
      repos: { ...ctx.repos, signalObservation: failingRepo },
    };

    const result = await backfillStrategyObservationCandidatesTool.execute(
      { limit: 10 },
      failingCtx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      scanned: 2,
      eligible: 2,
      created: 0,
      failed: 2,
    });
    expect(result.data.runs.every((run) => run.status === 'failed')).toBe(true);
    expect(result.data.warnings.some((warning) => warning.includes('2 个 run 补建失败'))).toBe(
      true,
    );
  });

  it('since/until 非法时返回 invalid_input', async () => {
    const ctx = await setup();
    const result = await backfillStrategyObservationCandidatesTool.execute(
      { since: new Date('2026-08-01T00:00:00Z'), until: new Date('2026-07-01T00:00:00Z') },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });
});
