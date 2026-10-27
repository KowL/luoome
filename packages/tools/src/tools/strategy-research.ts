import { createHash } from 'node:crypto';
import {
  ActiveSignalObservationHorizonSchema,
  AdaptivePersonalityAssessmentSchema,
  AdaptivePersonalityPolicySchema,
  assessAdaptivePersonality,
  classifyStrategyResult,
  type DailyBar,
  DailyBarSchema,
  DEFAULT_LOCAL_SELECTOR_PARAMETERS,
  diffStrategyDefinitions,
  getStrategyRunDataHealth,
  isHoliday,
  isWeekend,
  LocalSelectorCandidateSchema,
  LocalSelectorParametersV1Schema,
  LocalSelectorUnavailableSchema,
  readStrategyRunSnapshot,
  runLocalSelector,
  type SignalObservation,
  StrategyDefinitionDiffSchema,
  StrategyResearchComparisonRecordSchema,
  StrategyResearchSettingsSchema,
  StrategyResearchStateSchema,
  StrategyResultViewKindSchema,
  StrategyResultViewSchema,
  StrategyRunInputSnapshotV3Schema,
  StrategyRunSchema,
  type StrategyVersion,
  StrategyVersionSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import {
  captureStrategyComparisonSnapshot,
  StrategyComparisonInputIdentitySchema,
} from '../internal/strategy-comparison-snapshot.js';
import {
  TrialStrategyVersionInput,
  TrialStrategyVersionOutput,
  trialStrategyVersionTool,
} from './strategy-definition.js';

const DAY_MS = 86_400_000;
const OBSERVATION_QUERY_CHUNK = 400;

const shanghaiDayEnd = (date: string): Date => new Date(`${date}T15:59:59.999Z`);

export const RunLocalSelectorResearchInput = z.object({
  marketDate: z.string().date(),
  revisionCutoff: z.coerce.date(),
  stockIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  parameters: LocalSelectorParametersV1Schema.default(DEFAULT_LOCAL_SELECTOR_PARAMETERS),
});
export const RunLocalSelectorResearchOutput = z.object({
  status: z.enum(['complete', 'partial', 'unavailable']),
  parameters: LocalSelectorParametersV1Schema,
  snapshot: z.object({
    marketDate: z.string().date(),
    revisionCutoff: z.coerce.date(),
    universeSyncId: z.string().min(1),
    universeObservedAt: z.coerce.date(),
    memberChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    requestedCount: z.number().int().nonnegative(),
    evaluatedCount: z.number().int().nonnegative(),
    coverageRatio: z.number().min(0).max(1),
    dataAsOf: z.coerce.date().optional(),
  }),
  candidates: z.array(
    LocalSelectorCandidateSchema.extend({
      stockName: z.string().min(1),
      nameStatus: z.enum(['resolved', 'unavailable']),
    }),
  ),
  unavailableCount: z.number().int().nonnegative(),
  unavailableSamples: z.array(LocalSelectorUnavailableSchema).max(100),
  warnings: z.array(z.string().min(1)),
  limitations: z.array(z.string().min(1)),
});

const latestPITBars = (
  revisions: Awaited<ReturnType<ToolContext['repos']['dailyBar']['listRevisionsForStocks']>>,
): ReadonlyMap<string, readonly DailyBar[]> => {
  const latest = new Map<string, (typeof revisions)[number]>();
  for (const revision of revisions) {
    const key = `${revision.stockId}\0${revision.date.toISOString()}`;
    const previous = latest.get(key);
    if (
      previous === undefined ||
      revision.recordedAt > previous.recordedAt ||
      (revision.recordedAt.getTime() === previous.recordedAt.getTime() &&
        revision.contentHash.localeCompare(previous.contentHash) > 0)
    ) {
      latest.set(key, revision);
    }
  }
  const barsByStock = new Map<string, DailyBar[]>();
  for (const revision of latest.values()) {
    const bar = DailyBarSchema.parse({
      stockId: revision.stockId,
      date: revision.date,
      open: revision.open,
      high: revision.high,
      low: revision.low,
      close: revision.close,
      volume: revision.volume,
      adjustment: 'qfq',
      source: revision.source,
    });
    barsByStock.set(bar.stockId, [...(barsByStock.get(bar.stockId) ?? []), bar]);
  }
  for (const bars of barsByStock.values()) {
    bars.sort((left, right) => left.date.getTime() - right.date.getTime());
  }
  return barsByStock;
};

export const runLocalSelectorResearchTool = defineTool({
  name: 'run_local_selector_research',
  description:
    '使用 PIT StockUniverse 与批量 qfq DailyBar revision 做确定性横截面排序；score 仅用于研究排序，不是收益概率或 Advice',
  sideEffect: 'read',
  input: RunLocalSelectorResearchInput,
  output: RunLocalSelectorResearchOutput,
  handler: async (input, ctx) => {
    const marketDateEnd = shanghaiDayEnd(input.marketDate);
    if (isWeekend(marketDateEnd) || isHoliday(marketDateEnd)) {
      return errInvalidInput('marketDate 必须是 A 股交易日');
    }
    if (input.revisionCutoff < marketDateEnd) {
      return errInvalidInput('revisionCutoff 不能早于 marketDate 的上海收盘日终');
    }
    const universe = await ctx.repos.stockUniverse.latestSnapshotAtOrBefore({
      coverage: 'CN_A_SHARES_SH_SZ',
      asOf: marketDateEnd,
    });
    if (universe === null || universe.observedAt === null) {
      return errNotFound('StockUniverseSnapshot', input.marketDate);
    }
    const members = await ctx.repos.stockUniverse.listSnapshotMembers(universe.id);
    const memberById = new Map(members.map((stock) => [stock.id, stock] as const));
    const requested = [...new Set(input.stockIds ?? members.map((stock) => stock.id))].sort();
    const unknown = requested.filter((stockId) => !memberById.has(stockId));
    if (unknown.length > 0) {
      return errInvalidInput(`stockIds 不属于该 PIT StockUniverse: ${unknown.join(', ')}`);
    }
    const from = new Date(marketDateEnd.getTime() - input.parameters.minimumBars * 3 * DAY_MS);
    const revisions = await ctx.repos.dailyBar.listRevisionsForStocks({
      stockIds: requested,
      from,
      to: marketDateEnd,
      recordedAt: input.revisionCutoff,
    });
    const selected = runLocalSelector({
      stockIds: requested,
      barsByStock: latestPITBars(revisions),
      parameters: input.parameters,
    });
    const status =
      selected.evaluatedCount === 0
        ? ('unavailable' as const)
        : selected.coverageRatio >= input.parameters.minimumCoverageRatio
          ? ('complete' as const)
          : ('partial' as const);
    const chosen = selected.candidates
      .filter((candidate) => candidate.selected)
      .map((candidate) => {
        const stock = memberById.get(candidate.stockId);
        return {
          ...candidate,
          stockName: stock?.name ?? '名称暂缺',
          nameStatus: stock?.name === undefined ? ('unavailable' as const) : ('resolved' as const),
        };
      });
    const dataAsOf = chosen
      .map((candidate) => candidate.dataAsOf)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    return {
      status,
      parameters: input.parameters,
      snapshot: {
        marketDate: input.marketDate,
        revisionCutoff: input.revisionCutoff,
        universeSyncId: universe.id,
        universeObservedAt: universe.observedAt,
        memberChecksum: createHash('sha256').update(JSON.stringify(requested)).digest('hex'),
        requestedCount: requested.length,
        evaluatedCount: selected.evaluatedCount,
        coverageRatio: selected.coverageRatio,
        ...(dataAsOf === undefined ? {} : { dataAsOf }),
      },
      candidates: chosen,
      unavailableCount: selected.unavailable.length,
      unavailableSamples: selected.unavailable.slice(0, 100),
      warnings: [
        ...(status === 'partial'
          ? [
              `PIT 日线覆盖率 ${selected.coverageRatio.toFixed(4)} 低于参数门槛 ${input.parameters.minimumCoverageRatio.toFixed(4)}`,
            ]
          : []),
        ...(status === 'unavailable' ? ['PIT 日线不足，未产生横截面排序结论'] : []),
      ],
      limitations: [
        '横截面 score 只表示同一 PIT 批次内的相对排序，不是胜率、收益概率或 Advice confidence。',
        '结果不会自动创建 StrategyVersion、Watchlist 来源、Advice 或交易。',
      ],
    };
  },
});

export const AssessAdaptivePersonalityInput = z.object({
  parameterVersionId: z.string().min(1),
  trainingSessionId: z.string().min(1),
  validationSessionId: z.string().min(1),
  observationHorizon: ActiveSignalObservationHorizonSchema.default('t5'),
  policy: AdaptivePersonalityPolicySchema.default({
    policyVersion: 'adaptive-personality-gate-v1',
    minTrainingTradingDays: 60,
    minValidationTradingDays: 20,
    minValidationObservations: 30,
    minVintageCoverageRatio: 1,
    minBenchmarkCoverageRatio: 0.9,
  }),
});
export const AssessAdaptivePersonalityOutput = z.object({
  assessment: AdaptivePersonalityAssessmentSchema,
});

export const assessAdaptivePersonalityTool = defineTool({
  name: 'assess_adaptive_personality',
  description:
    '检查参数版本、训练/验证隔离、PIT vintage 与真实观察门禁；证据不足返回 unavailable 且不输出自适应结论',
  sideEffect: 'read',
  input: AssessAdaptivePersonalityInput,
  output: AssessAdaptivePersonalityOutput,
  handler: async (input, ctx) => {
    const [version, training, validation] = await Promise.all([
      ctx.repos.strategy.findVersionById(input.parameterVersionId),
      ctx.repos.strategyEvaluation.findSessionById(input.trainingSessionId),
      ctx.repos.strategyEvaluation.findSessionById(input.validationSessionId),
    ]);
    if (version === null) return errNotFound('StrategyVersion', input.parameterVersionId);
    if (training === null) return errNotFound('StrategyEvaluationSession', input.trainingSessionId);
    if (validation === null)
      return errNotFound('StrategyEvaluationSession', input.validationSessionId);
    const [trainingDays, validationDays, validationRuns] = await Promise.all([
      ctx.repos.strategyEvaluation.listDays(training.id),
      ctx.repos.strategyEvaluation.listDays(validation.id),
      ctx.repos.strategyRun.listRuns({
        strategyId: validation.strategyId,
        scope: 'evaluation',
        limit: 5000,
      }),
    ]);
    const runIds = new Set(
      validationDays.flatMap((day) => (day.runId === undefined ? [] : [day.runId])),
    );
    const runs = validationRuns.filter((run) => runIds.has(run.id));
    const signals = (
      await Promise.all(runs.map((run) => ctx.repos.strategyRun.signalsByRun(run.id)))
    ).flat();
    const observations: SignalObservation[] = [];
    for (let index = 0; index < signals.length; index += OBSERVATION_QUERY_CHUNK) {
      observations.push(
        ...(await ctx.repos.signalObservation.list({
          sourceKind: 'strategy-signal',
          sourceIds: signals
            .slice(index, index + OBSERVATION_QUERY_CHUNK)
            .map((signal) => signal.id),
          horizons: [input.observationHorizon],
          limit: 5000,
        })),
      );
    }
    const completeObservations = observations.filter(
      (observation) => observation.status === 'complete',
    );
    const assessment = assessAdaptivePersonality({
      parameterVersion: {
        strategyId: version.strategyId,
        strategyVersionId: version.id,
        definitionHash: version.definitionHash,
        factReferences: version.factReferences ?? [],
      },
      training: {
        sessionId: training.id,
        strategyId: training.strategyId,
        status: training.status,
        from: training.from,
        to: training.to,
        tradingDays: trainingDays.length,
        vintageAvailableDays: trainingDays.filter(
          (day) => day.vintageStatus === 'available' && day.status === 'complete',
        ).length,
      },
      validation: {
        sessionId: validation.id,
        strategyId: validation.strategyId,
        strategyVersionId: validation.strategyVersionId,
        status: validation.status,
        from: validation.from,
        to: validation.to,
        tradingDays: validationDays.length,
        vintageAvailableDays: validationDays.filter(
          (day) => day.vintageStatus === 'available' && day.status === 'complete',
        ).length,
        observationCount: completeObservations.length,
        benchmarkAvailableCount: completeObservations.filter(
          (observation) => observation.benchmarkStatus === 'complete',
        ).length,
      },
      policy: input.policy,
    });
    return { assessment };
  },
});

export const GetStrategyResearchStateInput = z.object({
  strategyId: z.string().min(1),
  accountId: z.string().min(1).optional(),
});
export const GetStrategyResearchStateOutput = z.object({
  state: StrategyResearchStateSchema.nullable(),
  versionDrift: z.boolean(),
  limitations: z.array(z.string()),
});
export const SaveStrategyResearchStateInput = GetStrategyResearchStateInput.extend({
  requestId: z.string().min(1).max(100),
  expectedRevision: z.number().int().nonnegative(),
  state: StrategyResearchSettingsSchema,
});
export const SaveStrategyResearchStateOutput = z.object({
  state: StrategyResearchStateSchema,
  replayed: z.boolean(),
});

export const getStrategyResearchStateTool = defineTool({
  name: 'get_strategy_research_state',
  description:
    '恢复指定账户与 Strategy 的研究问题、固定版本、范围、结论与下一步；披露已发布版本漂移',
  sideEffect: 'read',
  input: GetStrategyResearchStateInput,
  output: GetStrategyResearchStateOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if ((await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    const state = await ctx.repos.strategyEvaluation.findResearchState({
      strategyId: strategy.id,
      accountId,
    });
    const versionDrift =
      state !== null &&
      strategy.currentVersionId !== undefined &&
      strategy.currentVersionId !== state.state.baseVersionId;
    return {
      state,
      versionDrift,
      limitations: [
        '研究记录保留用户问题与结论，不自动产生验证通过、发布、建议或交易。',
        ...(versionDrift
          ? ['当前发布版本已变化；研究仍绑定保存的基线，必须显式选择是否换版。']
          : []),
      ],
    };
  },
});

export const saveStrategyResearchStateTool = defineTool({
  name: 'save_strategy_research_state',
  description:
    '按账户保存现有 Strategy 的研究问题、不可变版本、区间及人工结论；revision 检测冲突，requestId 支持相同请求重放',
  sideEffect: 'write',
  input: SaveStrategyResearchStateInput,
  output: SaveStrategyResearchStateOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if ((await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ expectedRevision: input.expectedRevision, state: input.state }))
      .digest('hex');
    const current = await ctx.repos.strategyEvaluation.findResearchState({
      strategyId: strategy.id,
      accountId,
    });
    if (current?.requestId === input.requestId)
      return current.requestHash === requestHash
        ? { state: current, replayed: true }
        : errInvalidInput('requestId 已用于不同的研究输入');
    if ((current?.revision ?? 0) !== input.expectedRevision)
      return errInvalidInput('research_revision_conflict：请读取已保存研究后重试');
    const versionIds = [
      ...new Set([
        input.state.baseVersionId,
        ...(input.state.candidateVersionId === undefined ? [] : [input.state.candidateVersionId]),
      ]),
    ];
    const versions = await Promise.all(
      versionIds.map((id) => ctx.repos.strategy.findVersionById(id)),
    );
    if (versions.some((version) => version === null || version.strategyId !== strategy.id))
      return errInvalidInput('研究基线/候选必须是同一 Strategy 的已保存版本');
    const comparison = input.state.comparison;
    if (comparison !== undefined) {
      const sample = input.state.stockIds;
      if (
        sample !== undefined &&
        createHash('sha256')
          .update(JSON.stringify([...new Set(sample)].sort()))
          .digest('hex') !== comparison.stockIdChecksum
      )
        return errInvalidInput('比较记录股票样本身份不一致');
      for (const row of comparison.candidates) {
        const version = await ctx.repos.strategy.findVersionById(row.candidateVersionId);
        if (version === null && row.status === 'complete')
          return errInvalidInput('完成的比较候选必须有已保存版本');
        if (
          version !== null &&
          (version.strategyId !== strategy.id ||
            (row.definitionHash !== undefined && row.definitionHash !== version.definitionHash))
        )
          return errInvalidInput('比较候选的策略/定义身份不一致');
      }
    }
    for (const id of [input.state.trainingSessionId, input.state.validationSessionId]) {
      if (id === undefined) continue;
      const session = await ctx.repos.strategyEvaluation.findSessionById(id);
      if (
        session === null ||
        session.strategyId !== strategy.id ||
        !versionIds.includes(session.strategyVersionId)
      )
        return errInvalidInput('研究会话必须属于当前策略与固定版本');
    }
    const conclusion = input.state.conclusion;
    if (conclusion?.outcome === 'supported' && conclusion.evidenceReferences.length === 0)
      return errInvalidInput('supported 结论必须引用可审计证据');
    for (const reference of conclusion?.evidenceReferences ?? []) {
      const colon = reference.indexOf(':');
      const kind = reference.slice(0, colon);
      const id = reference.slice(colon + 1);
      let valid = false;
      if (kind === 'strategy-version') valid = versionIds.includes(id);
      else if (kind === 'definition-hash')
        valid = versions.some((version) => version?.definitionHash === id);
      else if (kind === 'strategy-evaluation') {
        const session = await ctx.repos.strategyEvaluation.findSessionById(id);
        valid =
          session !== null &&
          session.strategyId === strategy.id &&
          versionIds.includes(session.strategyVersionId);
      } else if (kind === 'strategy-run') {
        const run = await ctx.repos.strategyRun.findRunById(id);
        valid =
          run !== null &&
          run.strategyId === strategy.id &&
          versionIds.includes(run.strategyVersionId);
      } else if (kind === 'strict-backtest') {
        const run = await ctx.repos.strategyBacktest.findRunById(id);
        valid =
          run !== null &&
          run.spec.strategyId === strategy.id &&
          versionIds.includes(run.spec.strategyVersionId);
      } else if (kind === 'signal-observation') {
        const observation = await ctx.repos.signalObservation.findById(id);
        if (observation?.sourceKind === 'strategy-signal' && observation.horizon !== 't20') {
          const signal = (await ctx.repos.strategyRun.signalsByIds([observation.sourceId]))[0];
          valid =
            signal !== undefined &&
            signal.strategyId === strategy.id &&
            versionIds.includes(signal.strategyVersionId);
        }
      }
      if (!valid) return errInvalidInput(`研究证据引用不存在或越出固定策略/版本范围：${reference}`);
    }
    const now = ctx.clock();
    const changedConclusion =
      conclusion !== undefined &&
      (JSON.stringify(conclusion) !== JSON.stringify(current?.state.conclusion) ||
        current?.state.baseVersionId !== input.state.baseVersionId ||
        current?.state.candidateVersionId !== input.state.candidateVersionId);
    const changedComparison =
      comparison !== undefined &&
      JSON.stringify(comparison) !== JSON.stringify(current?.state.comparison);
    if (changedConclusion && (current?.conclusions.length ?? 0) >= 100)
      return errInvalidInput(
        '研究结论已达 100 条，请导出并在新的策略研究中继续；不会自动删除旧结论',
      );
    if (changedComparison && (current?.comparisons?.length ?? 0) >= 100)
      return errInvalidInput('研究比较记录已达 100 条，请先导出；不会自动删除候选与失败');
    const state = StrategyResearchStateSchema.parse({
      strategyId: strategy.id,
      accountId,
      revision: input.expectedRevision + 1,
      requestId: input.requestId,
      requestHash,
      state: {
        ...input.state,
        ...(input.state.stockIds === undefined
          ? {}
          : { stockIds: [...new Set(input.state.stockIds)].sort() }),
      },
      conclusions: [
        ...(current?.conclusions ?? []),
        ...(changedConclusion
          ? [
              {
                revision: input.expectedRevision + 1,
                baseVersionId: input.state.baseVersionId,
                candidateVersionId: input.state.candidateVersionId,
                recordedAt: now,
                conclusion,
              },
            ]
          : []),
      ],
      comparisons: [...(current?.comparisons ?? []), ...(changedComparison ? [comparison] : [])],
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
    if (
      !(await ctx.repos.strategyEvaluation.saveResearchState({
        state,
        expectedRevision: input.expectedRevision,
      }))
    ) {
      const saved = await ctx.repos.strategyEvaluation.findResearchState({
        strategyId: strategy.id,
        accountId,
      });
      if (saved?.requestId === input.requestId && saved.requestHash === requestHash)
        return { state: saved, replayed: true };
      return errInvalidInput('research_revision_conflict：请读取已保存研究后重试');
    }
    return { state, replayed: false };
  },
});

export const RunStrategyResearchComparisonInput = TrialStrategyVersionInput.omit({
  draftVersionId: true,
}).extend({
  candidateVersionIds: z.array(z.string().min(1)).min(1).max(8),
  trainingSessionId: z.string().min(1).optional(),
  validationSessionId: z.string().min(1).optional(),
});
export const RunStrategyResearchComparisonOutput = z.object({
  inputIdentity: StrategyComparisonInputIdentitySchema,
  baseVersionId: z.string(),
  candidates: z.array(
    z.object({
      candidateVersionId: z.string(),
      status: z.enum(['complete', 'failed']),
      definitionDiff: StrategyDefinitionDiffSchema.optional(),
      comparison: TrialStrategyVersionOutput.optional(),
      assessment: AdaptivePersonalityAssessmentSchema.optional(),
      error: z.object({ kind: z.string(), message: z.string() }).optional(),
    }),
  ),
  trainingValidation: z.object({
    status: z.enum(['not-requested', 'isolated']),
    trainingSessionId: z.string().optional(),
    validationSessionId: z.string().optional(),
    validationUsedForSelection: z.literal(false),
  }),
  persisted: z.literal(false),
  limitations: z.array(z.string()),
  record: StrategyResearchComparisonRecordSchema,
});
export const runStrategyResearchComparisonTool = defineTool({
  name: 'run_strategy_research_comparison',
  description:
    '对最多 8 个已保存候选做共享事实快照对照，保留全部结果/失败；训练与验证必须隔离，不自动挑选最高收益参数',
  sideEffect: 'external',
  input: RunStrategyResearchComparisonInput,
  output: RunStrategyResearchComparisonOutput,
  handler: async (input, ctx) => {
    if (
      new Set(input.candidateVersionIds).size !== input.candidateVersionIds.length ||
      input.candidateVersionIds.includes(input.baseVersionId)
    )
      return errInvalidInput('候选必须互不相同且不能重复基线');
    if (input.mode === 'replay' && input.asOf === undefined)
      return errInvalidInput('mode=replay 时 asOf 必填');
    if (input.mode === 'scan' && (input.asOf !== undefined || input.revisionCutoff !== undefined))
      return errInvalidInput('scan 不接受历史 asOf/revisionCutoff');
    if (input.revisionCutoff !== undefined && input.revisionCutoff > ctx.clock())
      return errInvalidInput('revisionCutoff 不能在未来');
    const [strategy, base, candidates] = await Promise.all([
      ctx.repos.strategy.findById(input.strategyId),
      ctx.repos.strategy.findVersionById(input.baseVersionId),
      Promise.all(input.candidateVersionIds.map((id) => ctx.repos.strategy.findVersionById(id))),
    ]);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    if (base === null || base.strategyId !== input.strategyId || base.validationStatus !== 'valid')
      return errInvalidInput('基线必须是当前 Strategy 的 valid version');
    if (strategy.status !== 'active' && strategy.status !== 'draft')
      return errInvalidInput('Strategy 不接受试跑');
    if ((input.trainingSessionId === undefined) !== (input.validationSessionId === undefined))
      return errInvalidInput('trainingSessionId 与 validationSessionId 必须成对提供');
    if (input.trainingSessionId !== undefined && input.validationSessionId !== undefined) {
      const [training, validation] = await Promise.all([
        ctx.repos.strategyEvaluation.findSessionById(input.trainingSessionId),
        ctx.repos.strategyEvaluation.findSessionById(input.validationSessionId),
      ]);
      if (
        training === null ||
        validation === null ||
        training.strategyId !== input.strategyId ||
        validation.strategyId !== input.strategyId
      )
        return errInvalidInput('训练/验证会话必须属于当前 Strategy');
      if (training.id === validation.id || training.to >= validation.from)
        return errInvalidInput('训练与验证区间必须严格分离；验证区间不能用于参数选择');
      if (training.stockIdChecksum !== validation.stockIdChecksum)
        return errInvalidInput('训练/验证样本口径不一致');
    }
    const versions = candidates.filter(
      (version): version is StrategyVersion =>
        version !== null &&
        version.strategyId === input.strategyId &&
        version.validationStatus === 'valid',
    );
    const snapshot = await captureStrategyComparisonSnapshot({
      ctx,
      versions: [base, ...versions],
      stockIds: input.stockIds,
      mode: input.mode,
      ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
      ...(input.revisionCutoff === undefined ? {} : { revisionCutoff: input.revisionCutoff }),
    });
    if (input.mode === 'replay' && !snapshot.universeAvailable)
      return errInvalidInput('历史对照缺少指定时点的 PIT 股票池');
    const reports: z.infer<typeof RunStrategyResearchComparisonOutput>['candidates'] = [];
    for (const id of input.candidateVersionIds) {
      const candidate = versions.find((version) => version.id === id);
      const result = await trialStrategyVersionTool.execute(
        { ...input, draftVersionId: id },
        snapshot.ctx,
      );
      if (!result.ok) {
        reports.push({
          candidateVersionId: id,
          status: 'failed',
          error: {
            kind: result.error.kind,
            message: 'message' in result.error ? result.error.message : result.error.kind,
          },
        });
        continue;
      }
      const comparison = result.data;
      comparison.inputIdentity = snapshot.identity;
      for (const output of [comparison.base, comparison.draft])
        output.run.inputSnapshot = StrategyRunInputSnapshotV3Schema.parse({
          ...StrategyRunInputSnapshotV3Schema.parse(output.run.inputSnapshot),
          dataCheckpoint: {
            id: `memory:${snapshot.identity.snapshotHash}`,
            dataAsOf: snapshot.identity.dataAsOf,
            checksum: snapshot.identity.snapshotHash,
          },
        });
      const assessment =
        input.trainingSessionId === undefined || input.validationSessionId === undefined
          ? null
          : await assessAdaptivePersonalityTool.execute(
              {
                parameterVersionId: id,
                trainingSessionId: input.trainingSessionId,
                validationSessionId: input.validationSessionId,
              },
              ctx,
            );
      reports.push({
        candidateVersionId: id,
        status: 'complete',
        comparison,
        ...(candidate === undefined
          ? {}
          : {
              definitionDiff: diffStrategyDefinitions(
                base.definition,
                candidate.definition,
                base.definitionHash,
                candidate.definitionHash,
              ),
            }),
        ...(assessment?.ok ? { assessment: assessment.data.assessment } : {}),
        ...(assessment !== null && !assessment.ok
          ? {
              error: {
                kind: assessment.error.kind,
                message:
                  'message' in assessment.error ? assessment.error.message : assessment.error.kind,
              },
            }
          : {}),
      });
    }
    const limitations = [
      '候选按请求顺序全部返回，不按收益或分数自动择优；这是同快照规则敏感性对照，不是收益稳健性证明。',
      '候选定义与失败事实应随人工结论保存；内存快照本身不会跨进程保存。',
      ...snapshot.identity.limitations,
    ];
    const record = StrategyResearchComparisonRecordSchema.parse({
      origin: 'user-recorded',
      snapshotHash: snapshot.identity.snapshotHash,
      stockIdChecksum: snapshot.identity.stockIdChecksum,
      dataAsOf: snapshot.identity.dataAsOf,
      mode: input.mode,
      baseVersionId: base.id,
      candidates: reports.map((report) => ({
        candidateVersionId: report.candidateVersionId,
        definitionHash: versions.find((version) => version.id === report.candidateVersionId)
          ?.definitionHash,
        status: report.status,
        ...(report.comparison === undefined
          ? {}
          : {
              dataHealth: getStrategyRunDataHealth(report.comparison.draft.run),
              selectedCount: report.comparison.draft.results.filter((result) => result.selected)
                .length,
              missingCount: new Set([
                ...report.comparison.diagnostics.missingDraftStockIds,
                ...report.comparison.diagnostics.draft
                  .filter((view) => view.kind === 'incomplete')
                  .map((view) => view.result.stockId),
              ]).size,
            }),
        ...(report.error === undefined
          ? {}
          : { error: `${report.error.kind}: ${report.error.message}` }),
      })),
      limitations: [
        ...limitations,
        '保存后的比较摘要是用户记录；原始行情包未包含在记录中，不能仅凭输入 hash 当作已验证 PIT/收益证据。',
      ],
    });
    return {
      inputIdentity: snapshot.identity,
      baseVersionId: base.id,
      candidates: reports,
      trainingValidation: {
        status:
          input.trainingSessionId === undefined
            ? ('not-requested' as const)
            : ('isolated' as const),
        trainingSessionId: input.trainingSessionId,
        validationSessionId: input.validationSessionId,
        validationUsedForSelection: false as const,
      },
      persisted: false as const,
      limitations,
      record,
    };
  },
});

export const GetStrategySelectionDiagnosticsInput = z.object({
  strategyId: z.string().min(1),
  runId: z.string().min(1),
  view: StrategyResultViewKindSchema.optional(),
  query: z.string().trim().min(1).max(100).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(50),
});
export const GetStrategySelectionDiagnosticsOutput = z.object({
  run: StrategyRunSchema,
  version: StrategyVersionSchema,
  dataAsOf: z.coerce.date(),
  counts: z.object({
    selected: z.number().int().nonnegative(),
    ruleNearMiss: z.number().int().nonnegative(),
    rankingNearMiss: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    incomplete: z.number().int().nonnegative(),
    missingResults: z.number().int().nonnegative(),
  }),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  rows: z.array(
    z.object({
      stockId: z.string(),
      stockName: z.string(),
      view: StrategyResultViewSchema.optional(),
      missingReason: z.string().optional(),
    }),
  ),
  limitations: z.array(z.string()),
});
export const getStrategySelectionDiagnosticsTool = defineTool({
  name: 'get_strategy_selection_diagnostics',
  description:
    '只读指定运行的入选/规则临界/排名临界/未入选/缺失事实与评分分解，支持筛选分页；不刷新行情或改变已保存的事实',
  sideEffect: 'read',
  input: GetStrategySelectionDiagnosticsInput,
  output: GetStrategySelectionDiagnosticsOutput,
  handler: async (input, ctx) => {
    const run = await ctx.repos.strategyRun.findRunById(input.runId);
    if (run === null) return errNotFound('StrategyRun', input.runId);
    if (run.strategyId !== input.strategyId) return errInvalidInput('run 不属于该 Strategy');
    const version = await ctx.repos.strategy.findVersionById(run.strategyVersionId);
    if (version === null) return errNotFound('StrategyVersion', run.strategyVersionId);
    const results = await ctx.repos.strategyRun.listResults(run.id);
    const views = results.map((result) => classifyStrategyResult(version.definition, result));
    const expectedIds = readStrategyRunSnapshot(run.inputSnapshot).stockIds;
    const seen = new Set(results.map((result) => result.stockId));
    const missing = expectedIds.filter((id) => !seen.has(id));
    const universe = await ctx.repos.stockUniverse.listCurrent({ coverage: 'CN_A_SHARES_SH_SZ' });
    const names = new Map(universe.map((stock) => [stock.id, stock.name]));
    const counts = {
      selected: views.filter((view) => view.kind === 'selected').length,
      ruleNearMiss: views.filter((view) => view.kind === 'rule-near-miss').length,
      rankingNearMiss: views.filter((view) => view.kind === 'ranking-near-miss').length,
      excluded: views.filter((view) => view.kind === 'excluded').length,
      incomplete: views.filter((view) => view.kind === 'incomplete').length,
      missingResults: missing.length,
    };
    let rows: z.infer<typeof GetStrategySelectionDiagnosticsOutput>['rows'] = [
      ...views
        .filter((view) => input.view === undefined || view.kind === input.view)
        .map((view) => ({
          stockId: view.result.stockId,
          stockName: names.get(view.result.stockId) ?? '名称暂缺',
          view,
        })),
      ...(input.view === undefined || input.view === 'incomplete'
        ? missing.map((stockId) => ({
            stockId,
            stockName: names.get(stockId) ?? '名称暂缺',
            missingReason:
              '该股票没有已提交的规则结果，可能为上游失败或运行未完成；不将其解释为未入选。',
          }))
        : []),
    ];
    if (input.query !== undefined) {
      const query = input.query.toLowerCase();
      rows = rows.filter(
        (row) =>
          row.stockId.toLowerCase().includes(query) || row.stockName.toLowerCase().includes(query),
      );
    }
    rows.sort(
      (a, b) =>
        (a.view?.result.rank ?? Number.MAX_SAFE_INTEGER) -
          (b.view?.result.rank ?? Number.MAX_SAFE_INTEGER) || a.stockId.localeCompare(b.stockId),
    );
    return {
      run,
      version,
      dataAsOf: run.dataAsOf,
      counts,
      total: rows.length,
      offset: input.offset,
      limit: input.limit,
      rows: rows.slice(input.offset, input.offset + input.limit),
      limitations: [
        '规则/评分值绑定指定版本与运行事实截止；名称仅来自当前本地目录，不参与历史求值。',
        ...(run.status === 'running' ? ['运行尚未完成；当前缺失不能作为最终分类。'] : []),
      ],
    };
  },
});
