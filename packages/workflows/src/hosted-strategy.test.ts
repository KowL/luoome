import type { StockCode, StrategyDslV1, ToolContext } from '@luoome/core';
import { strategyDefinitionHash } from '@luoome/core';
import {
  prepareStrategyDataTool,
  reconcileStaleWorkflowRunsTool,
  runStrategyTool,
} from '@luoome/tools';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostedStrategyWorkflow } from './hosted-strategy.js';

const START = new Date('2026-08-10T10:00:00Z');
const fixture = async () => {
  let now = START;
  const base = await buildTestContext({
    clock: () => now,
    stockUniverse: {
      name: 'stock-universe',
      sources: ['fixture'],
      fetchStockUniverse: async () => ({
        source: 'fixture',
        coverage: 'CN_A_SHARES_SH_SZ',
        observedAt: now,
        complete: true,
        reportedTotal: 1,
        entries: [
          {
            stockId: '600519.SH',
            code: '600519' as StockCode,
            exchange: 'SH',
            name: '贵州茅台',
            listingStatus: 'listed',
          },
        ],
      }),
    },
  });
  const ctx: ToolContext = {
    ...base,
    hostedAuthorization: async () => null,
    identity: {
      mode: 'hosted',
      actor: 'worker',
      tenantId: 'tenant-A',
      tenantGeneration: 1,
      userId: base.user.id,
      requestId: 'request-A',
    },
    adapters: {
      ...base.adapters,
      llm: {
        name: 'offline',
        generate: async () => {
          throw new Error('offline');
        },
      },
    },
  };
  await seedTestStockUniverse(ctx, { limit: 1, observedAt: now });
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: {
      logic: 'all',
      rules: [{ id: 'all', name: 'all', when: 'true', evidence: ['fixture'] }],
    },
    signals: {
      entry: [
        {
          id: 'entry',
          name: 'entry',
          when: 'quote.close > 0',
          score: '80',
          direction: 'bullish',
          evidence: ['fixture'],
        },
      ],
      exit: [],
      risk: [],
    },
  };
  await ctx.repos.strategy.create({
    id: 'strategy',
    name: 'strategy',
    description: 'fixture',
    owner: 'user',
    status: 'active',
    currentVersionId: 'version',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.repos.strategy.createVersion({
    id: 'version',
    strategyId: 'strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  });
  await ctx.repos.strategySchedule.save({
    id: 'schedule',
    strategyId: 'strategy',
    cron: '0 18 * * 1-5',
    timezone: 'Asia/Shanghai',
    enabled: true,
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return {
    ctx,
    setTime: (date: string) => {
      now = new Date(date);
    },
    now: () => now,
    pass: (context = ctx) => hostedStrategyWorkflow.run({}, context),
  };
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('hosted Strategy daily worker', () => {
  it('facts-only 留存真实数据截止时间、缺失率及版本→信号→观察归属，报告交给 DS-3', async () => {
    const h = await fixture();
    expect(await h.pass()).toMatchObject({ ok: true, data: { acquired: true } });
    const run = await h.ctx.repos.strategyRun.findLatestPublishedRun('strategy');
    expect(run?.strategyVersionId).toBe('version');
    if (!run) throw new Error('published fixture missing');
    const signals = await h.ctx.repos.strategyRun.signalsByRun(run.id);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ runId: run.id, strategyVersionId: 'version' });
    const observations = await h.ctx.repos.signalObservation.list({
      sourceKind: 'strategy-signal',
    });
    expect(observations.map((row) => row.horizon).sort()).toEqual(['t1', 't3', 't5']);
    expect(observations.every((row) => row.sourceId === signals[0]?.id)).toBe(true);
    const audits = await h.ctx.repos.workflowRun.listStrategyDailyCycleAudits();
    expect(audits[0]?.outputSummary).toMatchObject({
      runId: run.id,
      insightProvider: 'facts-only',
      insightFacts: {
        dataAsOf: run.dataAsOf,
        observations: expect.arrayContaining([expect.objectContaining({ missingRate: 1 })]),
      },
    });
    expect(await h.ctx.repos.report.list({})).toEqual([]);
    expect(await h.pass()).toMatchObject({ ok: true, data: { acquired: false } });
    expect(await h.ctx.repos.strategyRun.listRuns()).toHaveLength(1);
  });

  it('没有到期 schedule 仍在 T+1/T+3/T+5 分别完成观察，重复 pass 不改写原事实', async () => {
    const h = await fixture();
    await h.pass();
    const schedule = await h.ctx.repos.strategySchedule.findById('schedule');
    if (!schedule) throw new Error('schedule fixture missing');
    await h.ctx.repos.strategySchedule.save({ ...schedule, enabled: false, nextRunAt: undefined });
    for (const [date, completed] of [
      ['2026-08-11', 1],
      ['2026-08-13', 2],
      ['2026-08-17', 3],
    ] as const) {
      h.setTime(`${date}T10:00:00Z`);
      expect((await h.pass()).ok).toBe(true);
      const rows = await h.ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal' });
      expect(rows.filter((row) => row.status === 'complete')).toHaveLength(completed);
      const snapshot = JSON.stringify(rows);
      h.setTime(`${date}T10:01:00Z`);
      await h.pass();
      expect(
        JSON.stringify(await h.ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal' })),
      ).toBe(snapshot);
    }
    expect(await h.ctx.repos.strategyRun.listRuns()).toHaveLength(1);
  });

  it('未 release 的租户/调度租约到期后接管，复用已发布运行并补建观察，不再调用 AI 或生成 Advice', async () => {
    const h = await fixture();
    const now = h.now();
    expect(
      await h.ctx.repos.workflowRun.execution({
        id: 'hosted-strategy-execution',
        workflowName: 'hosted-strategy-execution',
        action: 'acquire',
        owner: 'crashed',
        now,
        leaseUntil: new Date(now.getTime() + 120_000),
        nextRunAt: now,
      }),
    ).toBe(true);
    await h.ctx.repos.strategySchedule.claimDueWithFence({
      now,
      owner: 'crashed',
      leaseUntil: new Date(now.getTime() + 300_000),
      limit: 1,
    });
    const prepared = await prepareStrategyDataTool.execute({ strategyId: 'strategy' }, h.ctx);
    if (!prepared.ok) throw new Error('checkpoint fixture failed');
    const run = await runStrategyTool.execute(
      { strategyId: 'strategy', mode: 'scheduled', dataCheckpointId: prepared.data.checkpoint.id },
      h.ctx,
    );
    expect(run.ok).toBe(true);
    expect(
      await h.ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal' }),
    ).toHaveLength(0);
    expect(await h.pass()).toMatchObject({ ok: true, data: { acquired: false } });
    const ai = vi.spyOn(h.ctx.adapters.llm, 'generate');
    const adviceBefore = await h.ctx.repos.advice.query({});
    h.setTime('2026-08-10T10:06:00Z');
    expect(await h.pass()).toMatchObject({ ok: true, data: { cycle: { skipped: 1 } } });
    expect(await h.ctx.repos.strategyRun.listRuns()).toHaveLength(1);
    expect(
      await h.ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal' }),
    ).toHaveLength(3);
    expect(await h.ctx.repos.advice.query({})).toEqual(adviceBefore);
    expect(
      ai.mock.calls.filter(([input]) => input.system.includes('strategy_insight')),
    ).toHaveLength(0);
  });

  it('后续交易日上游失败不会覆盖已经发布的结果', async () => {
    const h = await fixture();
    await h.pass();
    const original = await h.ctx.repos.strategyRun.findLatestPublishedRun('strategy');
    if (!original) throw new Error('published fixture missing');
    const results = await h.ctx.repos.strategyRun.listResults(original.id);
    h.setTime('2026-08-12T10:00:00Z');
    const offline: ToolContext = {
      ...h.ctx,
      adapters: {
        ...h.ctx.adapters,
        market: {
          ...h.ctx.adapters.market,
          fetchDailyBars: async () => {
            throw new Error('network offline');
          },
        },
      },
    };
    expect(await h.pass(offline)).toMatchObject({ ok: true, data: { cycle: { failed: 1 } } });
    expect(await h.ctx.repos.strategyRun.findLatestPublishedRun('strategy')).toEqual(original);
    expect(await h.ctx.repos.strategyRun.listResults(original.id)).toEqual(results);
  });

  it('长洞察生成期间每 30 秒续租，原过期点不能被另一执行者接管', async () => {
    vi.useFakeTimers();
    const h = await fixture();
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let unblock = () => {};
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    vi.spyOn(h.ctx.adapters.llm, 'generate').mockImplementation(async () => {
      entered();
      await gate;
      throw new Error('fixture offline');
    });
    const pass = h.pass();
    await started;
    try {
      h.setTime('2026-08-10T10:00:30Z');
      await vi.advanceTimersByTimeAsync(30_000);
      const lease = await h.ctx.repos.workflowRun.findById('hosted-strategy-execution');
      expect(lease?.inputSummary?.heartbeatAtMs).toBe(h.now().getTime());
      h.setTime('2026-08-10T10:02:01Z');
      expect(
        await h.ctx.repos.workflowRun.execution({
          id: 'hosted-strategy-execution',
          workflowName: 'hosted-strategy-execution',
          action: 'acquire',
          owner: 'contender',
          now: h.now(),
          leaseUntil: new Date(h.now().getTime() + 120_000),
          nextRunAt: h.now(),
        }),
      ).toBe(false);
    } finally {
      unblock();
    }
    expect((await pass).ok).toBe(true);
  });

  it('旧 startedAt 的执行槽有有效续租时，通用 stale 审计收敛不会覆盖它', async () => {
    const h = await fixture();
    const now = h.now();
    expect(
      await h.ctx.repos.workflowRun.execution({
        id: 'hosted-strategy-execution',
        workflowName: 'hosted-strategy-execution',
        action: 'acquire',
        owner: 'long-running',
        now,
        leaseUntil: new Date(now.getTime() + 60 * 60_000),
        nextRunAt: now,
      }),
    ).toBe(true);
    h.setTime('2026-08-10T10:31:00Z');
    expect(
      await reconcileStaleWorkflowRunsTool.execute({ olderThanMinutes: 30 }, h.ctx),
    ).toMatchObject({ ok: true, data: { reconciled: 0, skipped: 1 } });
    expect((await h.ctx.repos.workflowRun.findById('hosted-strategy-execution'))?.status).toBe(
      'running',
    );
  });

  it('接管后旧执行者在正式运行提交前被 fencing 拒绝', async () => {
    vi.useFakeTimers();
    const h = await fixture();
    const commit = vi.spyOn(h.ctx.repos.strategyRun, 'commitRunWithFence');
    let calls = 0;
    const guarded: ToolContext = {
      ...h.ctx,
      hostedAuthorization: async (name) => {
        if (name === 'run_strategy' && ++calls === 2) {
          h.setTime('2026-08-10T10:03:00Z');
          expect(
            await h.ctx.repos.workflowRun.execution({
              id: 'hosted-strategy-execution',
              workflowName: 'hosted-strategy-execution',
              action: 'acquire',
              owner: 'successor',
              now: h.now(),
              leaseUntil: new Date(h.now().getTime() + 120_000),
              nextRunAt: h.now(),
            }),
          ).toBe(true);
          return {
            ok: false,
            error: { kind: 'lease_lost_before_commit', message: 'expired during computation' },
          };
        }
        return null;
      },
    };
    const result = await h.pass(guarded);
    expect(result.ok).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(await h.ctx.repos.strategyRun.findLatestPublishedRun('strategy')).toBeNull();
  });
});
