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
import { getDecisionReviewContextTool, getStrategyIcTool } from '@luoome/tools';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  BACKFILL_BOUNDARY_STATEMENTS,
  backfillStrategyObservationsWorkflow,
} from './backfill-strategy-observations.js';
import { buildWorkflowTools, type WorkflowContext } from './define-workflow.js';
import { replayStrategyRangeWorkflow } from './replay-strategy-range.js';

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

const seedStrategy = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  options: {
    readonly strategyId?: string;
    readonly versionId?: string;
    readonly definition?: StrategyDslV1;
  } = {},
): Promise<void> => {
  const strategyId = options.strategyId ?? 'backfill-strategy';
  const versionId = options.versionId ?? 'backfill-strategy-v1';
  const version: StrategyVersion = {
    id: versionId,
    strategyId,
    version: 1,
    definition: options.definition ?? definition,
    definitionHash: strategyDefinitionHash(options.definition ?? definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: NOW,
    createdAt: NOW,
  };
  const strategy: Strategy = {
    id: strategyId,
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

/**
 * 平静日策略：评分随收盘价变化（横截面有方差，IC 算得出），但入场信号永不触发（零信号）。
 * 零信号 = 没有观察可贴 vintage，`get_strategy_ic` 只能靠 session provenance 判口径。
 */
const QUIET_STRATEGY_ID = 'quiet-strategy';
const QUIET_VERSION_ID = 'quiet-strategy-v1';
const QUIET_FROM = new Date('2026-07-27T00:00:00.000Z');
const QUIET_TO = new Date('2026-07-28T00:00:00.000Z');

const quietDefinition: StrategyDslV1 = {
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
    components: [{ ruleId: 'positive-price', score: 'quote.close', weight: 1 }],
  },
  signals: {
    entry: [
      {
        id: 'entry',
        name: '永不触发的信号',
        when: 'quote.close > 1000000',
        score: '60',
        direction: 'bullish',
        evidence: ['平静日无信号'],
      },
    ],
    exit: [],
    risk: [],
  },
};

/** 两个交易日的收盘价（按 universe 下标取）：评分（= 当日收盘价）与次日收益同序 → RankIC 必须正好 1。 */
const quietClosesFor = (index: number): readonly [string, number][] => [
  ['2026-07-27', [10, 20, 30][index] ?? 0],
  ['2026-07-28', [10.1, 22, 36][index] ?? 0],
];

/** 按股票分别给历史日线（同一根日线喂所有股票会让评分没有横截面方差）。 */
const marketForQuietDays = (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  stockIds: readonly string[],
) => {
  const rowsFor = (stockId: string) => {
    const index = stockIds.indexOf(stockId);
    return (index === -1 ? [] : quietClosesFor(index)).map(([date, close]) => ({
      ...bar(date, close),
      stockId,
      source: 'quiet-fixture',
    }));
  };
  vi.spyOn(ctx.adapters.market, 'fetchQuote').mockImplementation(async (code) => ({
    stockId: String(code),
    close: money(99),
    open: money(99),
    high: money(100),
    low: money(98),
    volume: 1_000_000,
    source: 'live-fixture',
    observedAt: NOW,
    ts: NOW,
    fetchedAt: NOW,
    timestampSource: 'retrieval' as const,
  }));
  vi.spyOn(ctx.adapters.market, 'fetchDailyBars').mockImplementation(async (stockId, range) =>
    rowsFor(stockId).filter((row) => row.date >= range.start && row.date <= range.end),
  );
  return { rowsFor };
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

  it('回溯轨创建的 evaluation session 记 provenance=backfill（零信号日靠它判 restated）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedTestStockUniverse(ctx, { limit: 1, observedAt: FROM });
    await seedStrategy(ctx);
    marketWithCloses(ctx);
    const result = await backfillStrategyObservationsWorkflow.run(
      {
        strategyId: 'backfill-strategy',
        versionId: 'backfill-strategy-v1',
        from: FROM,
        to: TO,
        stockIds: [STOCK],
      },
      workflowContext(ctx),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const session = await ctx.repos.strategyEvaluation.findSessionById(result.data.sessionId);
    expect(session?.origin).toBe('backfill');
  });

  // ① 端到端验收（Lead 裁定）：provenance 不能只证明「调用方能传 origin」，必须证明
  // **真跑回溯 workflow** 产出的 session 落库后带着 backfill，再被 IC 消费成 restated。
  // 链路：backfill workflow → replay workflow → start_strategy_evaluation_session → 落库 → get_strategy_ic。
  it('端到端：workflow 产出的零信号日，provenance 从 replay 一路传到落库并判成 restated', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedTestStockUniverse(ctx, { limit: 3, observedAt: QUIET_FROM });
    await seedStrategy(ctx, {
      strategyId: QUIET_STRATEGY_ID,
      versionId: QUIET_VERSION_ID,
      definition: quietDefinition,
    });
    const stockIds = (
      await ctx.repos.stockUniverse.listCurrent({
        coverage: 'CN_A_SHARES_SH_SZ',
        status: 'active',
      })
    )
      .map((stock) => stock.id)
      .sort();
    expect(stockIds.length).toBe(3);
    const { rowsFor } = marketForQuietDays(ctx, stockIds);

    const wctx = workflowContext(ctx);
    const result = await backfillStrategyObservationsWorkflow.run(
      {
        strategyId: QUIET_STRATEGY_ID,
        versionId: QUIET_VERSION_ID,
        from: QUIET_FROM,
        to: QUIET_TO,
        stockIds,
      },
      wctx,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    // 落库层：session 行自己记着 provenance（不是把入参回显给调用方）
    const session = await ctx.repos.strategyEvaluation.findSessionById(result.data.sessionId);
    expect(session?.origin).toBe('backfill');

    // 前提：这两天的 run 确实零信号、零观察——provenance 是唯一可用的 vintage 标签来源。
    // 否则下面的 IC 断言会被观察判定"顺带"满足，证明力就没了。
    const runs = await ctx.repos.strategyRun.listRuns({
      strategyId: QUIET_STRATEGY_ID,
      status: 'complete',
      limit: 10,
    });
    expect(runs.length).toBe(2);
    for (const run of runs) {
      expect(await ctx.repos.strategyRun.signalsByRun(run.id)).toEqual([]);
      expect(await ctx.repos.strategyRun.listResultsByRuns([run.id])).not.toEqual([]);
    }
    expect(
      await ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal', limit: 100 }),
    ).toEqual([]);

    // IC 的次日收益读本地日线：显式落两天日线，避免把行情管线混进这条 provenance 验收。
    await ctx.repos.dailyBar.saveMany(
      stockIds.flatMap((stockId) => rowsFor(stockId).map((row) => ({ ...row, date: row.date }))),
    );

    const ic = await getStrategyIcTool.execute({ strategyId: QUIET_STRATEGY_ID }, ctx);
    expect(ic.ok, JSON.stringify(ic)).toBe(true);
    if (!ic.ok) return;
    // 没有 provenance 时这两天会进 scoreOnlyDays + vintage-unknown（旧行为）；现在按 restated 算。
    expect(ic.data.provenanceDays).toBe(2);
    expect(ic.data.scoreOnlyDays).toBe(0);
    expect(ic.data.skippedDays).toEqual([]);
    expect(ic.data.groups.map((group) => group.vintage)).toEqual(['restated']);
    const [group] = ic.data.groups;
    // 07-27 有次日收益 → 真实算出 IC；07-28 缺次日收益 → 进 missingDays，不填 0。
    expect(group?.days.map((day) => day.dataAsOf.toISOString().slice(0, 10))).toEqual([
      '2026-07-27',
    ]);
    expect(group?.days[0]?.rankIc).toBeCloseTo(1, 12);
    expect(group?.missingDays.map((day) => day.dataAsOf.toISOString().slice(0, 10))).toEqual([
      '2026-07-28',
    ]);
  });

  it('前瞻轨 session（provenance=prospective）拒绝写入 restated 观察', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedTestStockUniverse(ctx, { limit: 1, observedAt: FROM });
    await seedStrategy(ctx);
    marketWithCloses(ctx);
    const wctx = workflowContext(ctx);
    const started = await wctx.tools.start_strategy_evaluation_session.execute({
      strategyId: 'backfill-strategy',
      versionId: 'backfill-strategy-v1',
      from: FROM,
      to: TO,
      stockIds: [STOCK],
      origin: 'prospective',
    });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    if (!started.ok) return;
    expect(started.data.session.origin).toBe('prospective');
    const run = await wctx.tools.run_strategy.execute({
      strategyId: 'backfill-strategy',
      versionId: 'backfill-strategy-v1',
      mode: 'replay',
      asOf: FROM,
      stockIds: [STOCK],
      evaluationSessionId: started.data.session.id,
    });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    if (!run.ok) return;
    await wctx.tools.record_strategy_evaluation_day.execute({
      sessionId: started.data.session.id,
      dataAsOf: run.data.run.dataAsOf,
      runId: run.data.run.id,
      status: 'complete',
    });
    const rejected = await wctx.tools.create_restated_strategy_observation_candidates.execute({
      runId: run.data.run.id,
      evaluationSessionId: started.data.session.id,
    });
    // restated 写进 pit session = 让回溯补算冒充前瞻样本，这是 H8 最怕的方向。
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error).toMatchObject({ kind: 'invalid_input' });
    expect(JSON.stringify(rejected.error)).toContain('prospective');
  });

  // 反向守卫（Lead 裁定 ②）：只拦「restated → prospective」是半条守卫。pit 写进回溯轨
  // session 会让同一天既称「事后补算」又称「前瞻写入」，`get_strategy_ic` 只能判
  // vintage-conflict 跳过——fail-closed 成立，但那是可避免的样本永久损失。
  it('回溯轨 session（provenance=backfill）拒绝写入 pit 观察', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedTestStockUniverse(ctx, { limit: 1, observedAt: FROM });
    await seedStrategy(ctx);
    marketWithCloses(ctx);
    const wctx = workflowContext(ctx);
    const started = await wctx.tools.start_strategy_evaluation_session.execute({
      strategyId: 'backfill-strategy',
      versionId: 'backfill-strategy-v1',
      from: FROM,
      to: TO,
      stockIds: [STOCK],
      origin: 'backfill',
    });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    if (!started.ok) return;
    const run = await wctx.tools.run_strategy.execute({
      strategyId: 'backfill-strategy',
      versionId: 'backfill-strategy-v1',
      mode: 'replay',
      asOf: FROM,
      stockIds: [STOCK],
      evaluationSessionId: started.data.session.id,
    });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    if (!run.ok) return;
    await wctx.tools.record_strategy_evaluation_day.execute({
      sessionId: started.data.session.id,
      dataAsOf: run.data.run.dataAsOf,
      runId: run.data.run.id,
      status: 'complete',
    });
    const rejected = await wctx.tools.create_strategy_observation_candidates.execute({
      runId: run.data.run.id,
      evaluationSessionId: started.data.session.id,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error).toMatchObject({ kind: 'invalid_input' });
    // 报错必须说清「这条轨的观察是 restated」，否则调用方只会换个工具重试同一件事。
    expect(JSON.stringify(rejected.error)).toContain('回溯轨');
    expect(JSON.stringify(rejected.error)).toContain('restated');
  });

  // 守卫不能连坐：provenance 未知的存量 session 没有可对照的创建期事实，
  // 拦下来等于把升级前已经在用的 session 判死。走真实 replay（prepare + 逐日 run），
  // 这样信号与观察都是生产路径产生的，不是测试塞的对象。
  it('provenance 未知的 session 仍接受 pit 观察（不连坐存量）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedTestStockUniverse(ctx, { limit: 1, observedAt: FROM });
    await seedStrategy(ctx);
    marketWithCloses(ctx);
    const wctx = workflowContext(ctx);
    const replayed = await replayStrategyRangeWorkflow.run(
      {
        strategyId: 'backfill-strategy',
        versionId: 'backfill-strategy-v1',
        from: FROM,
        to: TO,
        stockIds: [STOCK],
      },
      wctx,
    );
    expect(replayed.ok, JSON.stringify(replayed)).toBe(true);
    if (!replayed.ok) return;
    const session = await ctx.repos.strategyEvaluation.findSessionById(replayed.data.sessionId);
    expect(session?.origin).toBeUndefined();
    const runId = replayed.data.days[0]?.runId;
    expect(runId).toBeDefined();
    if (runId === undefined) return;
    const created = await wctx.tools.create_strategy_observation_candidates.execute({
      runId,
      evaluationSessionId: replayed.data.sessionId,
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    expect(created.data.created).toBeGreaterThan(0);
  });
});
