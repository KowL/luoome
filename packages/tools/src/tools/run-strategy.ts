import { createHash } from 'node:crypto';
import {
  assessStrategyRun,
  assignStableStrategyRanks,
  compileStrategyQuotePrefilter,
  DEFAULT_STRATEGY_RUN_ACCEPTANCE_POLICY,
  dateInShanghai,
  decideStrategyRunPublication,
  decideStrategySignalEmission,
  deriveStrategyRunScope,
  deriveStrategyRunUniverseKind,
  evaluateStrategyStock,
  getStrategySignalEmission,
  inspectStrategyDefinitionReferences,
  isPublishableOperationalRun,
  readStrategyRunSnapshot,
  STRATEGY_EVALUATOR_CODE_HASH,
  STRATEGY_EVALUATOR_VERSION,
  type StrategyLeaseToken,
  StrategyResultSchema,
  type StrategyRunInputSnapshotV3,
  StrategyRunSchema,
  StrategySignalSchema,
  type StrategyStockEvaluation,
  type StrategyVersion,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import {
  defineTool,
  errInvalidInput,
  errLeaseLostBeforeCommit,
  errNotFound,
} from '../define-tool.js';
import { computeSimpleIndicators } from '../internal/indicators.js';
import {
  createCheckpointStrategyEvaluationDataAdapter,
  createLiveStrategyEvaluationDataAdapter,
  type StrategyEvaluationDataRequest,
} from '../internal/strategy-evaluation-data.js';
import { deriveStrategyMetaByStock } from '../internal/strategy-meta.js';

const EVALUATION_CONCURRENCY = 8;
const RUN_LEASE_MS = 15 * 60 * 1000;
const RUN_HEARTBEAT_MS = 5 * 60 * 1000;

export const RunStrategyInput = z.object({
  strategyId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  mode: z.enum(['scan', 'scheduled', 'replay']).default('scan'),
  asOf: z.coerce.date().optional(),
  /** replay 的 PIT universe 可在交易日内固化，独立于交易日 key 的 dataAsOf。 */
  universeAsOf: z.coerce.date().optional(),
  stockIds: z.array(z.string().min(1)).max(500).optional(),
  revisionCutoff: z.coerce.date().optional(),
  dataCheckpointId: z.string().min(1).optional(),
  evaluationSessionId: z.string().min(1).optional(),
  /** provider/CPU 受限并发；始终有上限，避免全市场扫描打爆上游。 */
  concurrency: z.number().int().min(1).max(64).default(EVALUATION_CONCURRENCY),
  /** 仅 scan evaluation 可显式启用；不会产生 operational publication。 */
  prefilter: z.object({ mode: z.literal('quote-selection-safe') }).optional(),
  acceptancePolicy: z
    .object({
      policyVersion: z.literal('strategy-run-acceptance-v1'),
      minEvaluatedRatio: z.number().min(0).max(1),
      maxFailedRatio: z.number().min(0).max(1),
      maxIncompleteRatio: z.number().min(0).max(1),
    })
    .optional(),
  persist: z.boolean().default(true),
});

export const RunStrategyOutput = z.object({
  run: StrategyRunSchema,
  results: z.array(StrategyResultSchema),
  signals: z.array(StrategySignalSchema),
  persisted: z.boolean(),
});

export const TrialStrategyInput = RunStrategyInput.extend({
  mode: z.enum(['scan', 'replay']).default('scan'),
  persist: z.literal(false).default(false),
});

export const TrialStrategyOutput = RunStrategyOutput.extend({
  persisted: z.literal(false),
});

const resolveVersion = async (
  strategyId: string,
  requestedVersionId: string | undefined,
  allowDraft: boolean,
  ctx: ToolContext,
): Promise<
  StrategyVersion | ReturnType<typeof errInvalidInput> | ReturnType<typeof errNotFound>
> => {
  const strategy = await ctx.repos.strategy.findById(strategyId);
  if (strategy === null) return errNotFound('Strategy', strategyId);
  if (strategy.status !== 'active') return errInvalidInput(`Strategy 不是 active: ${strategyId}`);
  const versionId = requestedVersionId ?? strategy.currentVersionId;
  if (versionId === undefined) return errInvalidInput('active Strategy 缺少 currentVersionId');
  const version = await ctx.repos.strategy.findVersionById(versionId);
  if (version === null) return errNotFound('StrategyVersion', versionId);
  if (version.strategyId !== strategy.id || version.validationStatus !== 'valid') {
    return errInvalidInput('run_strategy 只能运行同一 Strategy 的 valid version');
  }
  if (!allowDraft && version.publishedAt === undefined) {
    return errInvalidInput('persist=true 只能运行同一 Strategy 的 published valid version');
  }
  return version;
};

export const runStrategyTool = defineTool({
  name: 'run_strategy',
  description:
    '运行 Strategy selection/scoring/signals；外部行情只用于权威 StockUniverse 内候选，不会自动交易',
  sideEffect: 'external',
  requiredCapabilities: ['external', 'write'],
  input: RunStrategyInput,
  output: RunStrategyOutput,
  handler: async (input, ctx) => {
    if (input.mode === 'scheduled' && !input.persist) {
      return errInvalidInput('mode=scheduled 必须 persist=true');
    }
    if (input.mode === 'scheduled' && input.dataCheckpointId === undefined) {
      return errInvalidInput('mode=scheduled 必须带 dataCheckpointId');
    }
    if (input.mode === 'replay' && input.asOf === undefined) {
      return errInvalidInput('mode=replay 时 asOf 必填');
    }
    if (input.prefilter !== undefined && input.mode !== 'scan') {
      return errInvalidInput('prefilter 只允许用于 mode=scan 的 evaluation 运行');
    }
    if (input.mode !== 'replay' && input.revisionCutoff !== undefined) {
      return errInvalidInput('revisionCutoff 只允许用于 mode=replay');
    }
    if (input.mode !== 'replay' && input.asOf !== undefined) {
      return errInvalidInput(
        'mode=scan/scheduled 不支持 asOf：bars 会取历史而 quote 仍是实时，时点不一致；需要历史时点请用 mode=replay + 显式 stockIds',
      );
    }
    if (input.mode !== 'replay' && input.universeAsOf !== undefined) {
      return errInvalidInput('universeAsOf 只允许用于 mode=replay');
    }
    const resolved = await resolveVersion(input.strategyId, input.versionId, !input.persist, ctx);
    if ('ok' in resolved) return resolved;
    const version = resolved;
    const leaseOwner = `run-strategy:${globalThis.crypto.randomUUID()}`;
    const runId = `strategy-run-${globalThis.crypto.randomUUID()}`;
    const scope = deriveStrategyRunScope({
      mode: input.mode,
      hasExplicitStockIds: input.stockIds !== undefined || input.prefilter !== undefined,
    });
    const universeKind = deriveStrategyRunUniverseKind({
      hasExplicitStockIds: input.stockIds !== undefined || input.prefilter !== undefined,
    });
    let leaseToken: StrategyLeaseToken | null = null;
    let leaseLost = false;
    if (input.persist) {
      const leaseStartedAt = ctx.clock();
      leaseToken = await ctx.repos.strategyRun.acquireRunLeaseToken({
        strategyId: input.strategyId,
        strategyVersionId: version.id,
        owner: leaseOwner,
        runId,
        now: leaseStartedAt,
        leaseUntil: new Date(leaseStartedAt.getTime() + RUN_LEASE_MS),
      });
      if (leaseToken === null) return errInvalidInput('同一 StrategyVersion 已有正式运行执行中');
    }
    let startedRun: z.infer<typeof StrategyRunSchema> | undefined;
    let candidateIds: string[] = [];
    let dataAsOf = ctx.clock();
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let requestedBy: StrategyRunInputSnapshotV3['requestedBy'] = 'manual';
    try {
      if (input.persist && leaseToken !== null) {
        heartbeatTimer = setInterval(() => {
          const token = leaseToken;
          if (token === null || leaseLost) return;
          void ctx.repos.strategyRun
            .renewRunLease({
              token,
              now: ctx.clock(),
              leaseUntil: new Date(ctx.clock().getTime() + RUN_LEASE_MS),
            })
            .then((renewed) => {
              if (!renewed) leaseLost = true;
            })
            .catch(() => {
              leaseLost = true;
            });
        }, RUN_HEARTBEAT_MS);
      }
      const definition = version.definition;
      const references = inspectStrategyDefinitionReferences(definition);
      if (references.validationErrors.length > 0) {
        return errInvalidInput(references.validationErrors.join('; '));
      }

      const activeStocks = await ctx.repos.stockUniverse.listCurrent({
        coverage: 'CN_A_SHARES_SH_SZ',
        status: 'active',
      });
      dataAsOf = input.asOf ?? ctx.clock();
      const successfulSync =
        input.mode === 'replay'
          ? await ctx.repos.stockUniverse.latestSnapshotAtOrBefore({
              coverage: 'CN_A_SHARES_SH_SZ',
              asOf: input.universeAsOf ?? dataAsOf,
            })
          : await ctx.repos.stockUniverse.latestSuccessfulSync({
              coverage: 'CN_A_SHARES_SH_SZ',
            });
      if (input.stockIds === undefined && successfulSync === null) {
        return errInvalidInput('全市场运行需要已成功同步的 StockUniverse');
      }
      const snapshotStocks =
        successfulSync === null
          ? []
          : await ctx.repos.stockUniverse.listSnapshotMembers(successfulSync.id);
      if (
        input.stockIds === undefined &&
        (input.mode === 'replay' || input.mode === 'scheduled') &&
        snapshotStocks.length === 0
      ) {
        return errInvalidInput('该 mode 需要可读取的 immutable StockUniverse snapshot');
      }
      const validationStocks =
        input.stockIds === undefined && snapshotStocks.length > 0 ? snapshotStocks : activeStocks;
      const validationById = new Map(validationStocks.map((stock) => [stock.id, stock]));
      const requestedIds = input.stockIds ?? validationStocks.map((stock) => stock.id);
      const unknownIds = requestedIds.filter((stockId) => !validationById.has(stockId));
      if (unknownIds.length > 0) {
        return errInvalidInput(
          `stockIds 不属于可用 StockUniverse snapshot: ${unknownIds.join(', ')}`,
        );
      }
      const include = definition.universe.includeStockIds;
      const includeSet = include === undefined ? undefined : new Set(include);
      const excludeSet = new Set(definition.universe.excludeStockIds);
      candidateIds = [...new Set(requestedIds)]
        .filter((stockId) => includeSet === undefined || includeSet.has(stockId))
        .filter((stockId) => !excludeSet.has(stockId))
        .sort();
      const activeById = new Map(validationStocks.map((stock) => [stock.id, stock]));

      const startedAt = ctx.clock();
      dataAsOf = input.asOf ?? startedAt;
      const needsQuote = references.dataSources.includes('quote') || input.prefilter !== undefined;
      const needsDailyBars = references.dataSources.includes('daily-bars');
      const needsDerivedMeta = references.paths.some((path) => path.startsWith('meta.'));
      const needsLimitUpLadder = references.dataSources.includes('limit-up-ladder');
      const lookback = Math.max(1, references.requiredLookback);
      const universeMemberIds = [...new Set(requestedIds)].sort();
      const universeCheckpoint =
        successfulSync === null
          ? {
              syncId: `explicit:${createHash('sha256').update(universeMemberIds.join(',')).digest('hex')}`,
              provider: 'explicit-input',
              observedAt: dataAsOf,
              memberChecksum: createHash('sha256')
                .update(JSON.stringify(universeMemberIds))
                .digest('hex'),
            }
          : {
              syncId: successfulSync.id,
              provider: successfulSync.source,
              observedAt: successfulSync.observedAt ?? successfulSync.startedAt,
              memberChecksum: createHash('sha256')
                .update(JSON.stringify(universeMemberIds))
                .digest('hex'),
            };
      const dataCheckpoint =
        input.dataCheckpointId === undefined
          ? undefined
          : await ctx.repos.strategyDataCheckpoint.findById(input.dataCheckpointId);
      if (input.dataCheckpointId !== undefined && dataCheckpoint === null) {
        return errNotFound('StrategyDataCheckpoint', input.dataCheckpointId);
      }
      const usableDataCheckpoint = dataCheckpoint ?? undefined;
      const checkpointMembers =
        usableDataCheckpoint === undefined
          ? []
          : await ctx.repos.strategyDataCheckpoint.listMembers(usableDataCheckpoint.id);
      if (input.mode === 'scheduled' && usableDataCheckpoint === undefined) {
        return errInvalidInput('scheduled StrategyRun 的 data checkpoint 不可用');
      }
      if (input.mode === 'scheduled' && usableDataCheckpoint !== undefined) {
        const policy = input.acceptancePolicy ?? DEFAULT_STRATEGY_RUN_ACCEPTANCE_POLICY;
        const availableRatio =
          usableDataCheckpoint.requestedCount === 0
            ? 0
            : usableDataCheckpoint.availableCount / usableDataCheckpoint.requestedCount;
        if (
          (usableDataCheckpoint.status !== 'complete' &&
            usableDataCheckpoint.status !== 'partial') ||
          availableRatio < policy.minEvaluatedRatio
        ) {
          return errInvalidInput(
            `data-checkpoint-below-min: ${usableDataCheckpoint.availableCount}/${usableDataCheckpoint.requestedCount}`,
          );
        }
      }
      if (
        input.mode === 'scheduled' &&
        input.asOf === undefined &&
        usableDataCheckpoint !== undefined
      ) {
        // scheduled 的时点由 immutable checkpoint 决定；不能用运行开始时刻冒充输入新鲜度。
        dataAsOf = usableDataCheckpoint.dataAsOf;
      }
      if (
        usableDataCheckpoint !== undefined &&
        usableDataCheckpoint.dataAsOf.getTime() > dataAsOf.getTime()
      ) {
        return errInvalidInput('dataCheckpoint.dataAsOf 不能晚于 StrategyRun.dataAsOf');
      }
      if (
        (input.mode === 'scheduled' || input.mode === 'replay') &&
        successfulSync !== null &&
        usableDataCheckpoint !== undefined &&
        usableDataCheckpoint.universeSyncId !== successfulSync.id
      ) {
        return errInvalidInput(
          `${input.mode} StrategyRun 的 data checkpoint 必须来自同一 PIT universe sync`,
        );
      }
      if (
        (input.mode === 'scheduled' || input.mode === 'replay') &&
        usableDataCheckpoint !== undefined &&
        usableDataCheckpoint.memberChecksum !==
          createHash('sha256').update(JSON.stringify(universeMemberIds)).digest('hex')
      ) {
        return errInvalidInput(`${input.mode} StrategyRun 的 data checkpoint 成员集合不匹配`);
      }
      if (
        (input.mode === 'scheduled' || input.mode === 'replay') &&
        usableDataCheckpoint !== undefined
      ) {
        const observedTimes = checkpointMembers.flatMap((member) =>
          candidateIds.includes(member.stockId) &&
          member.status === 'available' &&
          member.latestBarDate !== undefined
            ? [member.latestBarDate.getTime()]
            : [],
        );
        const oldestObserved = Math.min(...observedTimes);
        if (Number.isFinite(oldestObserved)) dataAsOf = new Date(oldestObserved);
      }
      const evaluationRevisionCutoff =
        input.mode === 'replay' ? input.revisionCutoff : usableDataCheckpoint?.startedAt;
      const evaluationData =
        input.mode === 'scan'
          ? createLiveStrategyEvaluationDataAdapter(ctx)
          : createCheckpointStrategyEvaluationDataAdapter({
              ctx,
              mode: input.mode,
              members: checkpointMembers,
              ...(usableDataCheckpoint === undefined ? {} : { checkpoint: usableDataCheckpoint }),
              ...(evaluationRevisionCutoff === undefined
                ? {}
                : { revisionCutoff: evaluationRevisionCutoff }),
            });
      let limitUpLadderByCode = new Map<string, { readonly ladderLevel: number }>();
      let limitUpLadderProviderOk = !needsLimitUpLadder;
      let limitUpLadderDataAsOf: Date | undefined;
      let limitUpLadderErrorKind: string | undefined;
      if (needsLimitUpLadder) {
        if (input.mode === 'replay') {
          // Replay 只读取已持久化的真实 PIT 快照，不能读取当前可变天梯。
          try {
            const snapshot = await ctx.repos.limitUpLadderSnapshot.findByDate({
              date: dateInShanghai(dataAsOf),
              source: 'eastmoney',
            });
            if (snapshot === null) {
              limitUpLadderErrorKind = 'historical_snapshot_unavailable';
            } else {
              limitUpLadderProviderOk = true;
              limitUpLadderDataAsOf = snapshot.asOf;
              limitUpLadderByCode = new Map(
                snapshot.levels
                  .flatMap((level) => level.stocks)
                  .map((entry) => [entry.code, { ladderLevel: entry.ladderLevel }] as const),
              );
            }
          } catch (error) {
            limitUpLadderErrorKind = 'historical_snapshot_read_failed';
            ctx.logger.warn('读取历史天梯 PIT 快照失败', {
              date: dateInShanghai(dataAsOf),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else if (ctx.limitUpLadder === undefined) {
          limitUpLadderErrorKind = 'manager_unavailable';
        } else {
          const ladder = await ctx.limitUpLadder.fetchLadder({
            date: dateInShanghai(dataAsOf),
            source: 'eastmoney',
            days: 15,
            includeUncategorized: false,
            includeStar: false,
            includeBse: false,
            includeST: false,
          });
          if (ladder.ok && ladder.data !== undefined) {
            limitUpLadderProviderOk = true;
            limitUpLadderDataAsOf = ladder.data.asOf;
            limitUpLadderByCode = new Map(
              ladder.data.levels
                .flatMap((level) => level.stocks)
                .map((entry) => [entry.code, { ladderLevel: entry.ladderLevel }] as const),
            );
            try {
              await ctx.repos.limitUpLadderSnapshot.save(ladder.data);
            } catch (error) {
              // 当前扫描仍可使用真实返回，但不把未落库的结果冒充为可 replay 的 PIT 事实。
              limitUpLadderErrorKind = 'historical_snapshot_persist_failed';
              ctx.logger.warn('写入历史天梯 PIT 快照失败', {
                date: ladder.data.date,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          } else {
            limitUpLadderErrorKind = ladder.error?.kind ?? 'adapter_error';
          }
        }
      }

      let prefilterSnapshot:
        | {
            readonly mode: 'quote-selection-safe';
            readonly originalStockCount: number;
            readonly originalStockIdChecksum: string;
            readonly appliedRuleIds: readonly string[];
            readonly skippedRuleIds: readonly string[];
            readonly rejectedCount: number;
            readonly unavailableCount: number;
          }
        | undefined;
      const preloadedQuotes =
        input.mode === 'scan' && needsQuote && candidateIds.length > 0
          ? await evaluationData.preloadQuotes(candidateIds, input.concurrency)
          : new Map();
      if (input.prefilter !== undefined) {
        const prefilter = compileStrategyQuotePrefilter(definition);
        if (prefilter.applicableRuleIds.length === 0) {
          return errInvalidInput(
            '当前 Strategy 没有可由 quote 安全判定的 selection rule，无法预筛选',
          );
        }
        const originalCandidateIds = [...candidateIds];
        const originalStockIdChecksum = createHash('sha256')
          .update(JSON.stringify(originalCandidateIds))
          .digest('hex');
        let rejectedCount = 0;
        let unavailableCount = 0;
        candidateIds = originalCandidateIds.filter((stockId) => {
          const quote = preloadedQuotes.get(stockId);
          if (quote === undefined) {
            unavailableCount += 1;
            return true;
          }
          const decision = prefilter.evaluate(quote);
          if (decision.status === 'reject') {
            rejectedCount += 1;
            return false;
          }
          return true;
        });
        prefilterSnapshot = {
          mode: 'quote-selection-safe',
          originalStockCount: originalCandidateIds.length,
          originalStockIdChecksum,
          appliedRuleIds: prefilter.applicableRuleIds,
          skippedRuleIds: prefilter.skippedRuleIds,
          rejectedCount,
          unavailableCount,
        };
      }
      requestedBy =
        input.mode === 'replay' ? 'replay' : input.mode === 'scheduled' ? 'scheduled' : 'manual';
      startedRun = StrategyRunSchema.parse({
        id: runId,
        strategyId: input.strategyId,
        strategyVersionId: version.id,
        mode: input.mode,
        coverage: 'CN_A_SHARES_SH_SZ',
        dataAsOf,
        startedAt,
        status: 'running',
        scope,
        inputSnapshot: {
          schemaVersion: 3,
          strategyVersionId: version.id,
          definitionHash: version.definitionHash,
          evaluatorVersion: STRATEGY_EVALUATOR_VERSION,
          evaluatorCodeIdentity: STRATEGY_EVALUATOR_CODE_HASH,
          scope,
          universeKind,
          coverage: 'CN_A_SHARES_SH_SZ',
          stockIds: candidateIds,
          stockIdChecksum: createHash('sha256').update(JSON.stringify(candidateIds)).digest('hex'),
          requestedBy,
          universeCheckpoint,
          ...(usableDataCheckpoint === undefined
            ? {}
            : {
                dataCheckpoint: {
                  id: usableDataCheckpoint.id,
                  dataAsOf: usableDataCheckpoint.dataAsOf,
                  checksum: usableDataCheckpoint.dataChecksum,
                },
              }),
          acceptancePolicyVersion:
            input.acceptancePolicy?.policyVersion ??
            DEFAULT_STRATEGY_RUN_ACCEPTANCE_POLICY.policyVersion,
          ...(input.evaluationSessionId === undefined
            ? {}
            : { evaluationSessionId: input.evaluationSessionId }),
          ...(prefilterSnapshot === undefined ? {} : { prefilter: prefilterSnapshot }),
        },
        providerStatuses: [],
        providerCoverage: [],
      });
      if (input.persist) await ctx.repos.strategyRun.saveStartedRun(startedRun);

      const evaluationRequest: StrategyEvaluationDataRequest = {
        stockIds: candidateIds,
        dataAsOf,
        fetchedAt: startedAt,
        lookback,
        needsQuote,
        needsDailyBars,
        concurrency: input.concurrency,
        shouldContinue: () => !leaseLost,
      };
      const evaluationBatch = await evaluationData.load(evaluationRequest);
      if (leaseLost) return errLeaseLostBeforeCommit();
      const failures = evaluationBatch.failures;
      const preparedStocks = evaluationBatch.prepared;
      const metaByStock = needsDerivedMeta
        ? deriveStrategyMetaByStock(
            preparedStocks.map((item) => {
              const stock = activeById.get(item.stockId);
              const limitUpLadder =
                stock === undefined ? undefined : limitUpLadderByCode.get(stock.code);
              return {
                stockId: item.stockId,
                industry: stock?.industry,
                bars: item.bars,
                ...(limitUpLadder === undefined ? {} : { limitUpLadder }),
              };
            }),
          )
        : new Map<string, Readonly<Record<string, unknown>>>();
      const successful: StrategyStockEvaluation[] = preparedStocks.map((item) => {
        const itemDataAsOf = item.quote?.ts ?? item.bars.at(-1)?.date ?? dataAsOf;
        return evaluateStrategyStock({
          strategyId: input.strategyId,
          version,
          runId,
          stockId: item.stockId,
          ts: itemDataAsOf,
          dataAsOf: itemDataAsOf,
          context: {
            ...(item.quote === undefined ? {} : { quote: item.quote }),
            indicators: computeSimpleIndicators(item.bars),
            ...(needsDerivedMeta ? { meta: metaByStock.get(item.stockId) ?? {} } : {}),
          },
        });
      });
      const ranked = assignStableStrategyRanks(successful, definition);
      if (leaseLost) return errLeaseLostBeforeCommit();
      const results = ranked.map((item) => item.result);
      const rawSignals = ranked.flatMap((item) => item.signals);
      const priorRuns = (
        await ctx.repos.strategyRun.listRuns({
          strategyId: input.strategyId,
          scope,
          limit: 500,
        })
      )
        .filter((candidate) => {
          if (candidate.strategyVersionId !== version.id) return false;
          if (candidate.dataAsOf.getTime() >= dataAsOf.getTime()) return false;
          if (scope === 'operational' && !isPublishableOperationalRun(candidate)) return false;
          if (scope !== 'evaluation') return true;
          if (input.evaluationSessionId === undefined) return false;
          return (
            readStrategyRunSnapshot(candidate.inputSnapshot).evaluationSessionId ===
            input.evaluationSessionId
          );
        })
        .sort((left, right) => right.dataAsOf.getTime() - left.dataAsOf.getTime());
      const previousRun = priorRuns[0];
      const previousResults =
        previousRun === undefined ? [] : await ctx.repos.strategyRun.listResults(previousRun.id);
      const signalRules = new Map(
        [...definition.signals.entry, ...definition.signals.exit, ...definition.signals.risk].map(
          (rule) => [rule.id, rule] as const,
        ),
      );
      const previousMatchedByRuleStock = new Set(
        previousResults.flatMap((result) =>
          result.ruleEvaluations
            .filter(
              (evaluation) => evaluation.status === 'matched' && signalRules.has(evaluation.ruleId),
            )
            .map((evaluation) => `${evaluation.ruleId}\0${result.stockId}`),
        ),
      );
      const priorSignals = await Promise.all(
        priorRuns.map((run) => ctx.repos.strategyRun.signalsByRun(run.id)),
      );
      const previousByRuleStock = new Map<string, (typeof priorSignals)[number][number]>();
      for (const signalsForRun of priorSignals) {
        for (const signal of signalsForRun) {
          const key = `${signal.ruleId}\0${signal.stockId}`;
          const existing = previousByRuleStock.get(key);
          if (existing === undefined || existing.ts.getTime() < signal.ts.getTime()) {
            previousByRuleStock.set(key, signal);
          }
        }
      }
      const signals = rawSignals.filter((signal) => {
        const rule = signalRules.get(signal.ruleId);
        const key = `${signal.ruleId}\0${signal.stockId}`;
        const previousSignal = previousByRuleStock.get(key);
        const decision = decideStrategySignalEmission({
          ...(rule === undefined ? {} : { emission: getStrategySignalEmission(rule) }),
          matched: true,
          previousMatched: previousMatchedByRuleStock.has(key),
          ...(previousSignal === undefined ? {} : { previousSignal }),
          now: dataAsOf,
        });
        return decision.emit;
      });
      const evaluationAudit = evaluationData.audit(evaluationRequest, evaluationBatch);
      const incompleteCount = ranked.filter((item) => item.partial).length;
      const finishedAt = ctx.clock();
      const status =
        candidateIds.length > 0 && failures.length === candidateIds.length ? 'failed' : 'complete';
      const dataHealth =
        status === 'failed'
          ? 'unavailable'
          : failures.length > 0 || incompleteCount > 0
            ? 'partial'
            : 'complete';
      const error =
        status === 'failed' ? `全部 ${failures.length} 个 candidate 数据准备失败` : undefined;
      const acceptance = assessStrategyRun({
        status,
        universeCount: candidateIds.length,
        evaluatedCount: results.length,
        failedCount: failures.length,
        incompleteCount,
        ...(input.acceptancePolicy === undefined ? {} : { policy: input.acceptancePolicy }),
        assessedAt: finishedAt,
      });
      const publication = decideStrategyRunPublication({
        scope,
        universeKind,
        status,
        universeCheckpointPresent:
          successfulSync !== null && (input.stockIds !== undefined || snapshotStocks.length > 0),
        acceptance,
        decidedAt: finishedAt,
      });
      const run = StrategyRunSchema.parse({
        ...startedRun,
        dataAsOf,
        finishedAt,
        status,
        providerStatuses: [
          ...evaluationAudit.providerStatuses,
          ...(needsLimitUpLadder
            ? [
                {
                  provider:
                    input.mode === 'replay'
                      ? 'historical:limit-up-ladder'
                      : (ctx.limitUpLadder?.name ?? 'limit-up-ladder'),
                  ok: limitUpLadderProviderOk,
                  ...(limitUpLadderErrorKind === undefined
                    ? {}
                    : { errorKind: limitUpLadderErrorKind }),
                },
              ]
            : []),
        ],
        providerCoverage: [
          ...evaluationAudit.providerCoverage,
          ...(needsLimitUpLadder
            ? [
                {
                  capability: 'limit-up-ladder' as const,
                  provider:
                    input.mode === 'replay'
                      ? 'historical:limit-up-ladder'
                      : (ctx.limitUpLadder?.name ?? 'limit-up-ladder'),
                  requested: candidateIds.length,
                  succeeded: limitUpLadderProviderOk ? candidateIds.length : 0,
                  failed: 0,
                  missing: limitUpLadderProviderOk ? 0 : candidateIds.length,
                  fallbackUsed: false,
                  freshness: limitUpLadderProviderOk
                    ? ('fresh' as const)
                    : ('unavailable' as const),
                  ...(limitUpLadderDataAsOf === undefined
                    ? {}
                    : { dataAsOf: limitUpLadderDataAsOf }),
                  errorKinds: limitUpLadderErrorKind === undefined ? [] : [limitUpLadderErrorKind],
                },
              ]
            : []),
        ],
        summary: {
          schemaVersion: 4,
          dataHealth,
          universeCount: candidateIds.length,
          evaluatedCount: results.length,
          selectedCount: results.filter((result) => result.selected).length,
          signalCount: signals.length,
          incompleteCount,
          failedCount: failures.length,
          failureSamples: failures
            .slice(0, 20)
            .map(({ stockId, error: failureError }) => ({ stockId, error: failureError })),
          acceptance,
        },
        publication,
        ...(error === undefined ? {} : { error }),
      });
      if (input.persist) {
        if (leaseLost || leaseToken === null) return errLeaseLostBeforeCommit();
        const committed = await ctx.repos.strategyRun.commitRunWithFence({
          token: leaseToken,
          now: ctx.clock(),
          bundle: { run, results, signals },
        });
        if (committed === 'lease-lost') return errLeaseLostBeforeCommit();
      }
      return { run, results, signals, persisted: input.persist };
    } catch (runError) {
      if (input.persist && leaseLost) return errLeaseLostBeforeCommit();
      if (input.persist && startedRun !== undefined && !leaseLost && leaseToken !== null) {
        const stored = await ctx.repos.strategyRun.findRunById(startedRun.id);
        if (stored?.status === 'running') {
          const finishedAt = ctx.clock();
          const acceptance = assessStrategyRun({
            status: 'failed',
            universeCount: candidateIds.length,
            evaluatedCount: 0,
            failedCount: candidateIds.length,
            incompleteCount: 0,
            ...(input.acceptancePolicy === undefined ? {} : { policy: input.acceptancePolicy }),
            assessedAt: finishedAt,
          });
          const publication = decideStrategyRunPublication({
            scope,
            universeKind,
            status: 'failed',
            universeCheckpointPresent: false,
            acceptance,
            decidedAt: finishedAt,
          });
          const failed = StrategyRunSchema.parse({
            ...startedRun,
            finishedAt: finishedAt < startedRun.startedAt ? startedRun.startedAt : finishedAt,
            status: 'failed',
            summary: {
              schemaVersion: 4,
              dataHealth: 'unavailable',
              universeCount: candidateIds.length,
              evaluatedCount: 0,
              selectedCount: 0,
              signalCount: 0,
              incompleteCount: 0,
              failedCount: candidateIds.length,
              failureSamples: [],
              acceptance,
            },
            publication,
            error: runError instanceof Error ? runError.message : String(runError),
          });
          const committed = await ctx.repos.strategyRun.commitRunWithFence({
            token: leaseToken,
            now: ctx.clock(),
            bundle: { run: failed, results: [], signals: [] },
          });
          if (committed === 'lease-lost') {
            leaseLost = true;
            return errLeaseLostBeforeCommit();
          }
        }
      }
      throw runError;
    } finally {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      if (input.persist) {
        await ctx.repos.strategyRun.releaseRunLease({
          strategyId: input.strategyId,
          strategyVersionId: version.id,
          owner: leaseOwner,
          ...(leaseToken === null ? {} : { fence: leaseToken.fence }),
        });
      }
    }
  },
});

export const trialStrategyTool = defineTool({
  name: 'trial_strategy',
  description:
    '对单个 Strategy version 执行非持久化样本试跑；强制 persist=false，不支持 scheduled，不产生正式 StrategyRun',
  sideEffect: 'external',
  input: TrialStrategyInput,
  output: TrialStrategyOutput,
  handler: async (input, ctx) => {
    const result = await runStrategyTool.execute(
      {
        ...input,
        persist: false,
      },
      ctx,
    );
    if (!result.ok) return result;
    return result.data;
  },
});
