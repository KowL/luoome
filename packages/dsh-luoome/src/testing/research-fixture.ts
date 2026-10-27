import { createHash } from 'node:crypto';
import {
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
  DailyBarSchema,
  isHoliday,
  isWeekend,
  type Stock,
  type StrategyDslV1,
  type StrategyResult,
  type StrategyRun,
  type StrategySignal,
  signalObservationDueAt,
  strategyDefinitionHash,
  type ToolContext,
} from '@luoome/core';
import { saveStrategyResearchStateTool } from '@luoome/tools';

const strategyId = 'strategy-browser-research';
const stocks: readonly Stock[] = [
  { id: '600031.SH', code: '600031' as Stock['code'], exchange: 'SH', name: '合成入选样本' },
  { id: '000002.SZ', code: '000002' as Stock['code'], exchange: 'SZ', name: '合成规则临界样本' },
  { id: '000333.SZ', code: '000333' as Stock['code'], exchange: 'SZ', name: '合成未入选样本' },
  { id: '600100.SH', code: '600100' as Stock['code'], exchange: 'SH', name: '合成数据缺失样本' },
  { id: '600101.SH', code: '600101' as Stock['code'], exchange: 'SH', name: '合成排名临界样本' },
  { id: '600102.SH', code: '600102' as Stock['code'], exchange: 'SH', name: '合成结果未提交样本' },
];

export const RESEARCH_FIXTURE = Object.freeze({
  strategyId,
  strategyName: '策略研究验收（合成数据）',
  baseVersionId: `${strategyId}-v1`,
  candidateVersionId: `${strategyId}-v2`,
  secondCandidateVersionId: `${strategyId}-v3`,
  runId: `${strategyId}-run-latest`,
  previousRunId: `${strategyId}-run-previous`,
  sessionId: `${strategyId}-evaluation-recoverable`,
  stockIds: stocks.map((stock) => stock.id),
  from: '2026-10-12',
  to: '2026-10-19',
  benchmarkStockId: '000300.SH',
  trialAsOf: '2026-10-19T15:59:59.999Z',
});

const definition = (threshold = 10): StrategyDslV1 => ({
  schemaVersion: 1,
  metadata: { horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      {
        id: 'price-floor',
        name: '价格门槛',
        when: `quote.close >= ${threshold}`,
        evidence: ['合成收盘价'],
      },
      {
        id: 'volume-floor',
        name: '量能门槛',
        when: 'quote.volume >= 1000',
        evidence: ['合成成交量'],
      },
    ],
  },
  scoring: {
    method: 'weighted-sum',
    components: [{ ruleId: 'price-floor', score: 'quote.close', weight: 1 }],
    top: 1,
  },
  signals: {
    entry: [
      {
        id: 'entry',
        name: '合成规则入选',
        when: `quote.close >= ${threshold} && quote.volume >= 1000`,
        score: '70',
        direction: 'bullish',
        evidence: ['合成规则求值'],
      },
    ],
    exit: [],
    risk: [],
  },
});

const resultsFor = (run: StrategyRun): StrategyResult[] => {
  const previous = run.id === RESEARCH_FIXTURE.previousRunId;
  return stocks.slice(0, 5).map((stock, index) => {
    const close = (previous ? [11, 9, 8, undefined, 12] : [12, 9, 8, undefined, 11])[index];
    const volume = index === 2 ? 500 : 1500;
    const values = [close, index === 3 ? undefined : volume];
    return {
      runId: run.id,
      stockId: stock.id,
      selected: previous ? index === 4 : index === 0,
      ...(close === undefined
        ? {}
        : {
            score: close,
            ...(index === 0
              ? { rank: previous ? 2 : 1 }
              : index === 4
                ? { rank: previous ? 1 : 2 }
                : {}),
          }),
      dataAsOf: run.dataAsOf,
      evidence: ['仅用于隔离验收的合成规则事实'],
      ruleEvaluations: ['price-floor', 'volume-floor'].map((ruleId, ruleIndex) => {
        const value = values[ruleIndex];
        const matched = value !== undefined && value >= (ruleIndex === 0 ? 10 : 1000);
        return {
          schemaVersion: 2 as const,
          scope: 'selection' as const,
          ruleId,
          expression: ruleIndex === 0 ? 'quote.close >= 10' : 'quote.volume >= 1000',
          status:
            value === undefined
              ? ('unknown' as const)
              : matched
                ? ('matched' as const)
                : ('not-matched' as const),
          inputs: [
            {
              path: ruleIndex === 0 ? 'quote.close' : 'quote.volume',
              status: value === undefined ? ('missing' as const) : ('available' as const),
              ...(value === undefined ? {} : { value }),
            },
          ],
          explanation: {
            code:
              value === undefined
                ? ('missing-input' as const)
                : matched
                  ? ('matched' as const)
                  : ('not-matched' as const),
            message:
              value === undefined ? '合成样本缺少该字段，不计为零' : '合成规则输入与门槛比较',
          },
          evidence: ['隔离验收合成事实'],
        };
      }),
      scoringBreakdown: [
        {
          schemaVersion: 1 as const,
          ruleId: 'price-floor',
          expression: 'quote.close',
          weight: 1,
          inputs: [
            {
              path: 'quote.close',
              status: close === undefined ? ('missing' as const) : ('available' as const),
              ...(close === undefined ? {} : { value: close }),
            },
          ],
          ...(close === undefined
            ? { status: 'missing' as const }
            : { status: 'available' as const, rawScore: close, contribution: close }),
        },
      ],
    };
  });
};

/** Only called against isolated acceptance databases, never from production composition. */
export const seedResearchFixture = async (
  ctx: ToolContext,
  preserveStocks: readonly Stock[] = [],
): Promise<void> => {
  const now = ctx.clock();
  const createdAt = new Date('2026-09-01T08:00:00.000Z');
  const current = await ctx.repos.stockUniverse.listCurrent({
    coverage: 'CN_A_SHARES_SH_SZ',
    status: 'all',
  });
  const members = [
    ...new Map(
      [...current, ...preserveStocks, ...stocks].map((stock) => [stock.id, stock]),
    ).values(),
  ];
  await ctx.repos.stockUniverse.applySnapshot({
    syncId: 'research-browser-universe',
    appliedAt: createdAt,
    snapshot: {
      source: 'synthetic-research-fixture',
      coverage: 'CN_A_SHARES_SH_SZ',
      observedAt: createdAt,
      complete: true,
      reportedTotal: members.length,
      entries: members.map((stock) => ({
        stockId: stock.id,
        code: stock.code,
        exchange: stock.exchange,
        name: stock.name,
        listingStatus: 'listed' as const,
      })),
    },
  });
  await ctx.repos.strategy.create({
    id: strategyId,
    name: RESEARCH_FIXTURE.strategyName,
    description: '合成研究数据：规则、历史缺口和观察状态用于隔离验收，不是投资建议',
    owner: 'user',
    status: 'active',
    currentVersionId: RESEARCH_FIXTURE.baseVersionId,
    createdAt,
    updatedAt: now,
  });
  for (const [index, threshold] of [10, 11, 13].entries()) {
    const version = index + 1;
    const dsl = definition(threshold);
    await ctx.repos.strategy.createVersion({
      id: `${strategyId}-v${version}`,
      strategyId,
      version,
      definition: dsl,
      definitionHash: strategyDefinitionHash(dsl),
      validationStatus: 'valid',
      validationErrors: [],
      ...(version === 1
        ? { publishedAt: createdAt }
        : { parentVersionId: RESEARCH_FIXTURE.baseVersionId }),
      changeSummary: version === 1 ? '合成基线' : `仅将价格门槛改为 ${threshold}`,
      createdAt,
    });
  }
  const bars = [];
  for (
    let day = new Date('2026-09-01T00:00:00.000Z');
    day <= new Date('2026-10-26T00:00:00.000Z');
    day = new Date(day.getTime() + 86_400_000)
  ) {
    if (isWeekend(day) || isHoliday(day)) continue;
    for (const [index, stock] of stocks.entries()) {
      if (index === 3 || index === 5 || (index === 2 && day.toISOString().startsWith('2026-10-15')))
        continue;
      const close = (day < new Date('2026-10-19') ? [11, 9, 8, 10, 12] : [12, 9, 8, 10, 11])[
        index
      ] as number;
      bars.push(
        DailyBarSchema.parse({
          stockId: stock.id,
          date: day,
          open: close - 0.1,
          high: close + 0.2,
          low: close - 0.2,
          close,
          volume: index === 2 ? 500 : 1500,
          adjustment: 'qfq',
          source: 'synthetic-research-fixture',
        }),
      );
    }
    bars.push(
      DailyBarSchema.parse({
        stockId: RESEARCH_FIXTURE.benchmarkStockId,
        date: day,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 100000,
        adjustment: 'qfq',
        source: 'synthetic-research-fixture',
      }),
    );
  }
  await ctx.repos.dailyBar.saveMany(bars);
  await ctx.repos.dailyBar.saveRevisions(
    bars.map((bar) => ({
      ...bar,
      contentHash: createHash('sha256').update(JSON.stringify(bar)).digest('hex'),
      source: 'synthetic-research-fixture',
      recordedAt: new Date(bar.date.getTime() + 9 * 60 * 60_000),
    })),
  );
  for (const [index, runId] of [RESEARCH_FIXTURE.previousRunId, RESEARCH_FIXTURE.runId].entries()) {
    const dataAsOf = new Date(
      index === 0 ? '2026-10-16T07:00:00.000Z' : '2026-10-19T07:00:00.000Z',
    );
    const run: StrategyRun = {
      id: runId,
      strategyId,
      strategyVersionId: RESEARCH_FIXTURE.baseVersionId,
      mode: 'scheduled',
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf,
      startedAt: dataAsOf,
      finishedAt: dataAsOf,
      status: 'complete',
      scope: 'operational',
      inputSnapshot: { stockIds: [...RESEARCH_FIXTURE.stockIds], universeKind: 'explicit' },
      providerStatuses: [
        {
          provider: 'synthetic-research-fixture',
          ok: false,
          errorKind: 'missing-synthetic-samples',
        },
      ],
      summary: {
        schemaVersion: 3,
        dataHealth: 'partial',
        universeCount: 6,
        evaluatedCount: 5,
        selectedCount: 1,
        signalCount: 1,
        incompleteCount: 1,
        failedCount: 1,
        failureSamples: [{ stockId: stocks[5]?.id, error: 'synthetic_result_missing' }],
      },
      publication: { status: 'published', reasons: [], decidedAt: dataAsOf },
    };
    const signal: StrategySignal = {
      id: `${runId}-signal`,
      strategyId,
      strategyVersionId: RESEARCH_FIXTURE.baseVersionId,
      runId,
      ruleId: 'entry',
      stockId: stocks[index === 0 ? 4 : 0]?.id as string,
      ts: dataAsOf,
      score: 70,
      direction: 'bullish',
      evidence: ['隔离验收合成信号'],
      evaluationSnapshot: {},
    };
    await ctx.repos.strategyRun.commitRun({ run, results: resultsFor(run), signals: [signal] });
    for (const horizon of ACTIVE_SIGNAL_OBSERVATION_HORIZONS) {
      const dueAt = signalObservationDueAt(dataAsOf, horizon);
      const status =
        index === 1 && horizon === 't5'
          ? ('pending' as const)
          : index === 1 && horizon === 't3'
            ? ('unavailable' as const)
            : ('complete' as const);
      await ctx.repos.signalObservation.save({
        id: `${signal.id}-${horizon}`,
        sourceKind: 'strategy-signal',
        sourceId: signal.id,
        stockId: signal.stockId,
        baselinePrice: 12,
        baselineAt: dataAsOf,
        horizon,
        dueAt,
        status,
        benchmarkStatus: status === 'complete' ? 'complete' : 'unavailable',
        ...(status === 'complete'
          ? {
              closePrice: 12.24,
              returnPct: 2,
              maxFavorableExcursionPct: 3,
              maxAdverseExcursionPct: -1,
              benchmarkReturnPct: 1,
              observedAt: dueAt,
            }
          : status === 'unavailable'
            ? { unavailableReason: '隔离验收故意保留观察字段缺口' }
            : {}),
        provenance: {
          provider: 'synthetic-research-fixture',
          observedAt: status === 'complete' ? dueAt : now,
          fetchedAt: now,
          freshness: status === 'complete' ? 'fresh' : 'unavailable',
        },
      });
    }
  }
  const stockIds = [...RESEARCH_FIXTURE.stockIds].sort();
  await ctx.repos.strategyEvaluation.saveSession({
    id: RESEARCH_FIXTURE.sessionId,
    strategyId,
    strategyVersionId: RESEARCH_FIXTURE.candidateVersionId,
    from: new Date(RESEARCH_FIXTURE.from),
    to: new Date(RESEARCH_FIXTURE.to),
    stockIds,
    stockIdChecksum: createHash('sha256').update(JSON.stringify(stockIds)).digest('hex'),
    status: 'partial',
    error: 'synthetic_data_gap',
    definitionHash: strategyDefinitionHash(definition(11)),
    createdAt,
    finishedAt: now,
  });
  await ctx.repos.strategyEvaluation.saveDay({
    sessionId: RESEARCH_FIXTURE.sessionId,
    dataAsOf: new Date('2026-10-15T00:00:00.000Z'),
    status: 'failed',
    vintageStatus: 'unavailable',
    error: 'synthetic_missing_bar',
  });
  const saved = await saveStrategyResearchStateTool.execute(
    {
      strategyId,
      accountId: ctx.user.defaultAccountId,
      requestId: 'research-browser-initial-state',
      expectedRevision: 0,
      state: {
        question: '只提高价格门槛，能否在相同样本中减少规则临界结果？',
        baseVersionId: RESEARCH_FIXTURE.baseVersionId,
        candidateVersionId: RESEARCH_FIXTURE.candidateVersionId,
        stockIds,
        from: RESEARCH_FIXTURE.from,
        to: RESEARCH_FIXTURE.to,
        benchmarkStockId: RESEARCH_FIXTURE.benchmarkStockId,
        validationSessionId: RESEARCH_FIXTURE.sessionId,
        nextStep: '先核对字段覆盖，再做同快照对照；历史缺失不补零。',
        conclusion: {
          summary: '合成验收：已有历史缺口，研究结论保持待定。',
          outcome: 'inconclusive',
          limitations: ['合成数据只用于隔离验收，不代表真实供应商或投资表现。'],
          evidenceReferences: [
            `strategy-version:${RESEARCH_FIXTURE.baseVersionId}`,
            `strategy-run:${RESEARCH_FIXTURE.runId}`,
          ],
        },
      },
    },
    { ...ctx, clock: () => new Date(now.getTime() - 86_400_000) },
  );
  if (!saved.ok) throw new Error(`Research fixture state unavailable: ${saved.error.kind}`);
};
