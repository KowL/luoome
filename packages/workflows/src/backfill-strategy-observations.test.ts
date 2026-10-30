// T18 / REQ-M3-01 验收：回溯轨观察流水线。
//
// 五条验收逐条可红：历史行情 / vintage 逐行 / H8 三条禁用路径 / operational 字节级相等 / 三分法文案。
import {
  money,
  STANDARD_DISCLAIMERS,
  type Strategy,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { getDecisionReviewContextTool } from '@luoome/tools';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  BACKFILL_BOUNDARY_STATEMENTS,
  backfillStrategyObservationsWorkflow,
} from './backfill-strategy-observations.js';
import { buildWorkflowTools, type WorkflowContext } from './define-workflow.js';

/** buildTestContext 只给 ToolContext；workflow 步骤里的 ctx.tools 由引擎注入，测试要自己补。 */
const workflowContext = (ctx: Awaited<ReturnType<typeof buildTestContext>>): WorkflowContext =>
  ({ ...ctx, tools: buildWorkflowTools(ctx) }) as WorkflowContext;

const FROM = new Date('2026-07-27T00:00:00.000Z');
const TO = new Date('2026-07-27T00:00:00.000Z');
const NOW = new Date('2026-08-12T09:00:00.000Z');
const STOCK = '600519.SH';

/** 每个交易日的收盘价：回溯必须逐日拿到这些值，而不是"现在"的 99。 */
const CLOSES: ReadonlyArray<readonly [string, number]> = [
  ['2026-07-27', 10],
  ['2026-07-28', 11],
  ['2026-07-29', 12],
];
const CURRENT_CLOSE = 99;

const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: {},
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      { id: 'positive-price', name: '价格有效', when: 'quote.close > 0', evidence: ['价格有效'] },
    ],
  },
  scoring: {
    method: 'weighted-sum',
    components: [{ ruleId: 'positive-price', score: '50', weight: 1 }],
  },
  signals: {
    entry: [
      {
        id: 'entry',
        name: '历史信号',
        when: 'quote.close > 0',
        score: '60',
        direction: 'bullish',
        evidence: ['历史输入'],
      },
    ],
    exit: [],
    risk: [],
  },
};

const seedStrategy = async (ctx: Awaited<ReturnType<typeof buildTestContext>>): Promise<void> => {
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
    name: '回溯轨测试策略',
    description: 'T18 验收',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await ctx.repos.strategy.create(strategy);
  await ctx.repos.strategy.createVersion(version);
};

const bar = (date: string, close: number) => {
  const at = new Date(`${date}T00:00:00.000Z`);
  return {
    stockId: STOCK,
    date: at,
    open: money(close),
    high: money(close + 1),
    low: money(close - 1),
    close: money(close),
    volume: 1_000_000,
    adjustment: 'qfq' as const,
    source: 'backfill-fixture',
  };
};

/** 只按区间返回该区间内的历史日线；"今天"那根用 99，代表当前行情。 */
const marketWithCloses = (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  vi.spyOn(ctx.adapters.market, 'fetchQuote').mockImplementation(async (code) => ({
    stockId: String(code),
    close: money(CURRENT_CLOSE),
    open: money(CURRENT_CLOSE),
    high: money(CURRENT_CLOSE + 1),
    low: money(CURRENT_CLOSE - 1),
    volume: 1_000_000,
    source: 'live-fixture',
    observedAt: NOW,
    ts: NOW,
    fetchedAt: NOW,
    timestampSource: 'retrieval' as const,
  }));
  return vi.spyOn(ctx.adapters.market, 'fetchDailyBars').mockImplementation(async (_id, range) => {
    const rows = [
      ...CLOSES.map(([date, close]) => bar(date, close)),
      bar('2026-08-12', CURRENT_CLOSE),
    ];
    return rows.filter((row) => row.date >= range.start && row.date <= range.end);
  });
};

const observationsOf = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) =>
  ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal', limit: 10_000 });

describe('T18 回溯轨观察流水线', () => {
  it('历史行情：checkpoint 版 baselinePrice 等于该交易日收盘价，且与当前行情不同', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedTestStockUniverse(ctx, { limit: 1, observedAt: FROM });
    await seedStrategy(ctx);
    marketWithCloses(ctx);

    const wctx = workflowContext(ctx);
    const result = await backfillStrategyObservationsWorkflow.run(
      {
        strategyId: 'backfill-strategy',
        versionId: 'backfill-strategy-v1',
        from: FROM,
        to: TO,
        stockIds: [STOCK],
      },
      wctx,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    const rows = (await observationsOf(ctx)).filter((row) => row.vintage === 'restated');
    const baselines = [...new Set(rows.map((row) => row.baselinePrice))].sort(
      (a, b) => (a ?? 0) - (b ?? 0),
    );
    // checkpoint 版 = 每个交易日的收盘价
    expect(baselines).toEqual([10]);
    for (const row of rows) {
      const expected = CLOSES.find(
        ([date]) => row.baselineAt?.toISOString().slice(0, 10) === date,
      )?.[1];
      expect(row.baselinePrice, `baseline 必须等于 ${String(expected)} 那天的收盘价`).toBe(
        expected,
      );
    }

    // 对照：故意喂"当前行情"（asOf=今天）跑同一策略，baselinePrice 必须是 99。
    // 对照：故意喂"当前行情"——price_snapshots 里放 99，走 scan（前瞻）路径。
    await ctx.repos.quote.save({
      stockId: STOCK,
      close: money(CURRENT_CLOSE),
      open: money(CURRENT_CLOSE),
      high: money(CURRENT_CLOSE + 1),
      low: money(CURRENT_CLOSE - 1),
      volume: 1_000_000,
      source: 'live-fixture',
      observedAt: NOW,
      ts: NOW,
      fetchedAt: NOW,
      timestampSource: 'retrieval' as const,
    });
    const live = await wctx.tools.run_strategy.execute({
      strategyId: 'backfill-strategy',
      versionId: 'backfill-strategy-v1',
      stockIds: [STOCK],
    });
    expect(live.ok, JSON.stringify(live)).toBe(true);
    if (!live.ok) return;
    const liveSignals = await ctx.repos.strategyRun.signalsByRun(live.data.run.id);
    const liveBaseline = liveSignals[0]?.evaluationSnapshot.baseline as
      | { price?: number }
      | undefined;
    expect(liveBaseline?.price).toBe(CURRENT_CLOSE);
    expect(liveBaseline?.price).not.toBe(baselines[0]);
  });

  it('vintage 逐行 100% restated，且 sourceKind 与 vintage 不互推', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedTestStockUniverse(ctx, { limit: 1, observedAt: FROM });
    await seedStrategy(ctx);
    marketWithCloses(ctx);
    const wctx = workflowContext(ctx);
    const result = await backfillStrategyObservationsWorkflow.run(
      {
        strategyId: 'backfill-strategy',
        versionId: 'backfill-strategy-v1',
        from: FROM,
        to: TO,
        stockIds: [STOCK],
      },
      wctx,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    const rows = (await observationsOf(ctx)).filter((row) => row.vintage === 'restated');
    expect(rows.length).toBeGreaterThan(0);
    // 逐行 100%
    expect(rows.length).toBe(rows.filter((row) => row.vintage === 'restated').length);

    // 【主证据】两种 vintage 都由**生产写入方**产生：
    //   - pit：run_strategy(mode='scheduled') → published operational run → create_strategy_observation_candidates
    //   - restated：回溯轨 workflow → create_restated_strategy_observation_candidates
    // 两者 sourceKind 同为 'strategy-signal'、sourceId 不同（不同 runId 派生），因此"sourceKind 与 vintage
    // 不互推"是被真实写入路径证明的，而不是靠测试塞对象。
    // 注意：不能传 stockIds —— explicit subset 会被判定为 non-publishing（core/strategy/publication.ts:69,75），
    // 拿不到 published operational run；这里用 checkpoint 的完整 universe（fixture 只种了 1 只）。
    const prepared = await wctx.tools.prepare_strategy_data.execute({
      strategyId: 'backfill-strategy',
      asOf: NOW,
    });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;
    const scheduled = await wctx.tools.run_strategy.execute({
      strategyId: 'backfill-strategy',
      versionId: 'backfill-strategy-v1',
      mode: 'scheduled',
      dataCheckpointId: prepared.data.checkpoint.id,
    });
    expect(scheduled.ok, JSON.stringify(scheduled)).toBe(true);
    if (!scheduled.ok) return;
    const pitCreated = await wctx.tools.create_strategy_observation_candidates.execute({
      runId: scheduled.data.run.id,
    });
    expect(pitCreated.ok, JSON.stringify(pitCreated)).toBe(true);
    const pitRows = (await observationsOf(ctx)).filter((row) => row.vintage === 'pit');
    expect(pitRows.length).toBeGreaterThan(0);
    expect(new Set(pitRows.map((row) => row.sourceKind))).toEqual(new Set(['strategy-signal']));
    expect(new Set(rows.map((row) => row.sourceKind))).toEqual(new Set(['strategy-signal']));
    // 生产写入方确实写出了两种口径，且 sourceId 不同（id 不含 vintage，同一 sourceId 只能一种口径）。
    expect(
      pitRows.every((row) => !rows.some((restated) => restated.sourceId === row.sourceId)),
    ).toBe(true);

    // 【次要证据】表层约束：repo 直写也能让同一 sourceKind 同时存两种 vintage。
    // 这一条**不能**单独作为验收主证据——它证明的是"表能存"，不是"生产写入方会写"。
    await ctx.repos.signalObservation.save({
      id: 'signal-observation:strategy-signal:pit-signal:t1',
      sourceKind: 'strategy-signal',
      sourceId: 'pit-signal',
      stockId: STOCK,
      baselinePrice: 10,
      baselineAt: FROM,
      horizon: 't1',
      vintage: 'pit',
      status: 'pending',
      benchmarkStatus: 'unavailable',
      provenance: {
        provider: 'strategy-signal',
        observedAt: FROM,
        fetchedAt: NOW,
        freshness: 'unknown',
      },
    });
    const all = await observationsOf(ctx);
    const synthetic = all.find((row) => row.sourceId === 'pit-signal');
    expect(synthetic?.vintage).toBe('pit');
    expect(synthetic?.sourceKind).toBe('strategy-signal');
  });

  it('operational 统计 before/after 字节级相等', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedTestStockUniverse(ctx, { limit: 1, observedAt: FROM });
    await seedStrategy(ctx);
    marketWithCloses(ctx);
    const wctx = workflowContext(ctx);
    // 对照：故意喂"当前行情"——price_snapshots 里放 99，走 scan（前瞻）路径。
    await ctx.repos.quote.save({
      stockId: STOCK,
      close: money(CURRENT_CLOSE),
      open: money(CURRENT_CLOSE),
      high: money(CURRENT_CLOSE + 1),
      low: money(CURRENT_CLOSE - 1),
      volume: 1_000_000,
      source: 'live-fixture',
      observedAt: NOW,
      ts: NOW,
      fetchedAt: NOW,
      timestampSource: 'retrieval' as const,
    });
    // 必须走 published operational run 才能产 pit 行；否则 operational 集合为空，
    // "字节级相等"会退化成"两个空数组相等"的假绿（本次自查发现的第二处假绿）。
    const prepared = await wctx.tools.prepare_strategy_data.execute({
      strategyId: 'backfill-strategy',
      asOf: NOW,
    });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;
    const live = await wctx.tools.run_strategy.execute({
      strategyId: 'backfill-strategy',
      versionId: 'backfill-strategy-v1',
      mode: 'scheduled',
      dataCheckpointId: prepared.data.checkpoint.id,
    });
    expect(live.ok, JSON.stringify(live)).toBe(true);
    if (!live.ok) return;
    const pitCreated = await wctx.tools.create_strategy_observation_candidates.execute({
      runId: live.data.run.id,
    });
    expect(pitCreated.ok, JSON.stringify(pitCreated)).toBe(true);
    if (pitCreated.ok) expect(pitCreated.data.created).toBeGreaterThan(0);

    // 字节级 = 整行比。只剔除三项**回填后本应变化**的字段：
    //   - 观察行的 `vintage`（pit 行不会变，但它是本次回填唯一允许改写的口径字段）；
    //   - stats 的 `vintageCounts`（回填后多出 restated 计数）；
    //   - stats 的 `limitations`（回填后多出 restated 披露文案）。
    // 其余 operational 可写字段全部参与比较（closePrice / MFE / MAE / observedAt / benchmark* /
    // attemptCount / dueAt / lastAttemptAt / nextAttemptAt / lastErrorKind / unavailableReason /
    // provenance / baselinePrice / baselineAt，以及 stats 的 sampleUnit / missingRate / observedAsOf）。
    const projectObservation = (row: Record<string, unknown>): Record<string, unknown> => {
      const { vintage: _vintage, ...rest } = row;
      return rest;
    };
    const projectStats = (data: Record<string, unknown>): Record<string, unknown> => {
      const { vintageCounts: _counts, limitations: _limitations, ...rest } = data;
      return rest;
    };
    const snapshot = async (): Promise<string> => {
      const stats = await wctx.tools.get_signal_observation_stats.execute({});
      expect(stats.ok, JSON.stringify(stats)).toBe(true);
      const operational = (await observationsOf(ctx)).filter((row) => row.vintage === 'pit');
      return JSON.stringify({
        stats: stats.ok ? projectStats(stats.data as unknown as Record<string, unknown>) : null,
        operational: operational.map((row) =>
          projectObservation(row as unknown as Record<string, unknown>),
        ),
        publication: (await ctx.repos.strategy.findById('backfill-strategy'))?.currentVersionId,
      });
    };
    const before = await snapshot();
    const result = await backfillStrategyObservationsWorkflow.run(
      {
        strategyId: 'backfill-strategy',
        versionId: 'backfill-strategy-v1',
        from: FROM,
        to: TO,
        stockIds: [STOCK],
      },
      wctx,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await snapshot()).toBe(before);

    // 灵敏度自检：投影必须对"Lead 点名的漏项字段"敏感——改一个 closePrice，快照必须变。
    // 否则这条"字节级"会退化成只比 id/status/returnPct 的假绿。
    const pitRow = (await observationsOf(ctx)).find((row) => row.vintage === 'pit');
    if (pitRow === undefined) throw new Error('missing pit fixture');
    await ctx.repos.signalObservation.save({ ...pitRow, closePrice: money(123) });
    expect(await snapshot()).not.toBe(before);
    await ctx.repos.signalObservation.save(pitRow);
    expect(await snapshot()).toBe(before);
  });

  it('H8 三条禁用路径各被拒：历史命中陈述 / Advice 证据链 / 复盘当时依据', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedTestStockUniverse(ctx, { limit: 1, observedAt: FROM });
    await seedStrategy(ctx);
    marketWithCloses(ctx);
    const wctx = workflowContext(ctx);
    const result = await backfillStrategyObservationsWorkflow.run(
      {
        strategyId: 'backfill-strategy',
        versionId: 'backfill-strategy-v1',
        from: FROM,
        to: TO,
        stockIds: [STOCK],
      },
      wctx,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    // ① 策略历史命中陈述
    const review = await wctx.tools.get_decision_loop_review.execute({});
    expect(review.ok).toBe(false);
    if (!review.ok)
      expect(JSON.stringify(review.error)).toContain('restated 观察不得用于策略历史命中陈述');

    // ② Advice 证据链（实验结论会把 observationIds 写进 factReferences）
    const experiment = await wctx.tools.get_strategy_experiment_context.execute({
      strategyId: 'backfill-strategy',
      candidateVersionId: 'backfill-strategy-v1',
      validationSessionId: result.data.sessionId,
    });
    expect(experiment.ok).toBe(false);
    if (!experiment.ok)
      expect(JSON.stringify(experiment.error)).toContain('restated 观察不得用于Advice 证据链');

    // ③ DecisionReview 的「当时依据」：把 restated 观察挂到 advice 的策略证据上
    const restated = (await observationsOf(ctx)).filter((row) => row.vintage === 'restated');
    const signal = (await ctx.repos.strategyRun.signalsByRun(result.data.days[0]?.runId ?? ''))[0];
    if (signal === undefined) throw new Error('missing fixture signal');
    const advice = {
      id: 'advice-backfill-restated',
      subjectKind: 'stock' as const,
      subjectId: STOCK,
      decision: 'hold' as const,
      confidence: 60,
      horizon: 'short' as const,
      reasoning: { premise: '回溯轨验收', evidence: ['fixture'], counterEvidence: [] },
      risks: ['fixture'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'backfill-acceptance',
      basedOn: {
        dataAsOf: FROM,
        strategy: {
          strategyId: 'backfill-strategy',
          strategyVersionId: 'backfill-strategy-v1',
          runId: signal.runId,
          stockId: STOCK,
          resultEvidence: ['fixture'],
          signalIds: [signal.id],
          observationIds: restated.map((row) => row.id),
          recommendationTrigger: 'run' as const,
        },
      },
      validFrom: FROM,
      validUntil: new Date(FROM.getTime() + 30 * 86_400_000),
      createdAt: FROM,
    };
    await ctx.repos.advice.save(advice);
    const reviewContext = await getDecisionReviewContextTool.execute(
      { subject: { kind: 'advice', id: advice.id } },
      ctx,
    );
    expect(reviewContext.ok).toBe(false);
    if (!reviewContext.ok)
      expect(JSON.stringify(reviewContext.error)).toContain('DecisionReview 的「当时依据」');
  });

  it('三分法文案：三类各一句，(b) 必须点明"看似可补实不可补"的具体陷阱', () => {
    expect(BACKFILL_BOUNDARY_STATEMENTS.a).toContain('可补');
    expect(BACKFILL_BOUNDARY_STATEMENTS.b).toContain('看似可补实不可补');
    for (const trap of [
      '可实现换手',
      '信号胜率不等于建议命中率',
      '幸存偏差',
      '超额收益',
      '成本后净收益',
    ]) {
      expect(BACKFILL_BOUNDARY_STATEMENTS.b).toContain(trap);
    }
    expect(BACKFILL_BOUNDARY_STATEMENTS.c).toContain('能补但被排除');
    expect(BACKFILL_BOUNDARY_STATEMENTS.c).toContain('当时可见性');
  });
});
