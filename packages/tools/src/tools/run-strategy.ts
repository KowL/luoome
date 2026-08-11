import { createHash } from 'node:crypto';
import {
  assignStableStrategyRanks,
  type DailyBar,
  evaluateStrategyStock,
  inspectStrategyDefinitionReferences,
  type Quote,
  StrategyResultSchema,
  StrategyRunSchema,
  StrategySignalSchema,
  type StrategyStockEvaluation,
  type StrategyVersion,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { computeSimpleIndicators } from '../internal/indicators.js';
import {
  observationsForStrategySignal,
  type StrategySignalBaseline,
  saveObservationCandidates,
} from '../internal/signal-observation.js';
import { deriveStrategyMetaByStock } from '../internal/strategy-meta.js';

const DAY_MS = 86_400_000;
const EVALUATION_CONCURRENCY = 8;
const EVALUATOR_VERSION = 'strategy-evaluator-v2';
const RUN_LEASE_MS = 2 * 60 * 60 * 1000;

export const RunStrategyInput = z.object({
  strategyId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  mode: z.enum(['scan', 'scheduled', 'replay']).default('scan'),
  asOf: z.coerce.date().optional(),
  stockIds: z.array(z.string().min(1)).max(500).optional(),
  persist: z.boolean().default(true),
});

export const RunStrategyOutput = z.object({
  run: StrategyRunSchema,
  results: z.array(StrategyResultSchema),
  signals: z.array(StrategySignalSchema),
  persisted: z.boolean(),
});

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item !== undefined) results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
};

const quoteFromDailyBar = (bar: DailyBar, fetchedAt: Date): Quote => ({
  stockId: bar.stockId,
  observedAt: bar.date,
  fetchedAt,
  timestampSource: 'upstream',
  ts: bar.date,
  open: bar.open,
  high: bar.high,
  low: bar.low,
  close: bar.close,
  volume: bar.volume,
  source: bar.source,
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
  input: RunStrategyInput,
  output: RunStrategyOutput,
  handler: async (input, ctx) => {
    if (input.mode === 'replay' && input.asOf === undefined) {
      return errInvalidInput('mode=replay 时 asOf 必填');
    }
    if (input.mode === 'replay' && input.stockIds === undefined) {
      return errInvalidInput(
        '历史 StockUniverse snapshot 尚未提供；mode=replay 仅允许显式 stockIds 子集',
      );
    }
    if (input.mode !== 'replay' && input.asOf !== undefined) {
      return errInvalidInput(
        'mode=scan/scheduled 不支持 asOf：bars 会取历史而 quote 仍是实时，时点不一致；需要历史时点请用 mode=replay + 显式 stockIds',
      );
    }
    const resolved = await resolveVersion(input.strategyId, input.versionId, !input.persist, ctx);
    if ('ok' in resolved) return resolved;
    const version = resolved;
    const leaseOwner = `run-strategy:${globalThis.crypto.randomUUID()}`;
    if (input.persist) {
      const leaseStartedAt = ctx.clock();
      const acquired = await ctx.repos.strategyRun.acquireRunLease({
        strategyId: input.strategyId,
        strategyVersionId: version.id,
        owner: leaseOwner,
        now: leaseStartedAt,
        leaseUntil: new Date(leaseStartedAt.getTime() + RUN_LEASE_MS),
      });
      if (!acquired) return errInvalidInput('同一 StrategyVersion 已有正式运行执行中');
    }
    let startedRun: z.infer<typeof StrategyRunSchema> | undefined;
    try {
      const definition = version.definition;
      const references = inspectStrategyDefinitionReferences(definition);
      if (references.validationErrors.length > 0) {
        return errInvalidInput(references.validationErrors.join('; '));
      }

      const activeStocks = await ctx.repos.stockUniverse.listCurrent({
        coverage: 'CN_A_SHARES_SH_SZ',
        status: 'active',
      });
      const successfulSync = await ctx.repos.stockUniverse.latestSuccessfulSync({
        coverage: 'CN_A_SHARES_SH_SZ',
      });
      if (input.stockIds === undefined) {
        if (successfulSync === null) {
          return errInvalidInput('全市场运行需要已成功同步的 StockUniverse');
        }
      }
      const activeById = new Map(activeStocks.map((stock) => [stock.id, stock]));
      const requestedIds = input.stockIds ?? activeStocks.map((stock) => stock.id);
      const unknownIds = requestedIds.filter((stockId) => !activeById.has(stockId));
      if (unknownIds.length > 0) {
        return errInvalidInput(`stockIds 不属于 active StockUniverse: ${unknownIds.join(', ')}`);
      }
      const include = definition.universe.includeStockIds;
      const includeSet = include === undefined ? undefined : new Set(include);
      const excludeSet = new Set(definition.universe.excludeStockIds);
      const candidateIds = [...new Set(requestedIds)]
        .filter((stockId) => includeSet === undefined || includeSet.has(stockId))
        .filter((stockId) => !excludeSet.has(stockId))
        .sort();

      const startedAt = ctx.clock();
      const dataAsOf = input.asOf ?? startedAt;
      const runId = `strategy-run-${globalThis.crypto.randomUUID()}`;
      const needsQuote = references.dataSources.includes('quote');
      const needsDailyBars = references.dataSources.includes('daily-bars');
      const needsDerivedMeta = references.paths.some((path) => path.startsWith('meta.'));
      const lookback = Math.max(1, references.requiredLookback);
      startedRun = StrategyRunSchema.parse({
        id: runId,
        strategyId: input.strategyId,
        strategyVersionId: version.id,
        mode: input.mode,
        coverage: 'CN_A_SHARES_SH_SZ',
        dataAsOf,
        startedAt,
        status: 'running',
        inputSnapshot: {
          schemaVersion: 2,
          strategyVersionId: version.id,
          definitionHash: version.definitionHash,
          evaluatorVersion: EVALUATOR_VERSION,
          coverage: 'CN_A_SHARES_SH_SZ',
          stockIds: candidateIds,
          stockIdChecksum: createHash('sha256').update(JSON.stringify(candidateIds)).digest('hex'),
          requestedBy:
            input.mode === 'replay'
              ? 'replay'
              : input.mode === 'scheduled'
                ? 'scheduled'
                : 'manual',
          ...(successfulSync === null
            ? {}
            : {
                universeCheckpoint: {
                  provider: successfulSync.source,
                  syncedAt: successfulSync.finishedAt ?? successfulSync.startedAt,
                },
              }),
        },
        providerStatuses: [],
      });
      if (input.persist) await ctx.repos.strategyRun.saveStartedRun(startedRun);

      const prepared = await mapWithConcurrency(
        candidateIds,
        EVALUATION_CONCURRENCY,
        async (
          stockId,
        ): Promise<
          | {
              readonly ok: true;
              readonly stockId: string;
              readonly bars: readonly DailyBar[];
              readonly quote?: Quote;
            }
          | { readonly ok: false; readonly stockId: string; readonly error: string }
        > => {
          try {
            let bars: readonly DailyBar[] = [];
            let quote: Quote | undefined;
            if (input.mode === 'replay') {
              if (needsDailyBars || needsQuote) {
                bars = await ctx.repos.dailyBar.latestBefore(stockId, dataAsOf, lookback);
              }
              const latestBar = bars.at(-1);
              if (needsQuote && latestBar !== undefined) {
                quote = quoteFromDailyBar(latestBar, startedAt);
              }
            } else {
              if (needsDailyBars) {
                bars = await ctx.adapters.market.fetchDailyBars(stockId, {
                  start: new Date(dataAsOf.getTime() - Math.max(lookback * 2, 30) * DAY_MS),
                  end: dataAsOf,
                });
              }
              if (needsQuote) quote = await ctx.adapters.market.fetchQuote(stockId);
            }
            return {
              ok: true,
              stockId,
              bars,
              ...(quote === undefined ? {} : { quote }),
            };
          } catch (error) {
            return {
              ok: false,
              stockId,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      );

      const failures = prepared.filter(
        (item): item is Extract<(typeof prepared)[number], { ok: false }> => !item.ok,
      );
      const preparedStocks = prepared.flatMap((item) => (item.ok ? [item] : []));
      const baselineByStock = new Map<string, StrategySignalBaseline>(
        preparedStocks.flatMap((item) => {
          if (item.quote !== undefined) {
            return [
              [
                item.stockId,
                {
                  price: item.quote.close,
                  at: item.quote.ts,
                  provider: item.quote.source,
                },
              ] as const,
            ];
          }
          const latestBar = item.bars.at(-1);
          return latestBar === undefined
            ? []
            : [
                [
                  item.stockId,
                  {
                    price: latestBar.close,
                    at: latestBar.date,
                    provider: latestBar.source,
                  },
                ] as const,
              ];
        }),
      );
      const metaByStock = needsDerivedMeta
        ? deriveStrategyMetaByStock(
            preparedStocks.map((item) => ({
              stockId: item.stockId,
              industry: activeById.get(item.stockId)?.industry,
              bars: item.bars,
            })),
          )
        : new Map<string, Readonly<Record<string, unknown>>>();
      const successful: StrategyStockEvaluation[] = preparedStocks.map((item) =>
        evaluateStrategyStock({
          strategyId: input.strategyId,
          version,
          runId,
          stockId: item.stockId,
          ts: dataAsOf,
          dataAsOf,
          context: {
            ...(item.quote === undefined ? {} : { quote: item.quote }),
            indicators: computeSimpleIndicators(item.bars),
            ...(needsDerivedMeta ? { meta: metaByStock.get(item.stockId) ?? {} } : {}),
          },
        }),
      );
      const ranked = assignStableStrategyRanks(successful, definition);
      const results = ranked.map((item) => item.result);
      const signals = ranked.flatMap((item) => item.signals);
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
      const run = StrategyRunSchema.parse({
        ...startedRun,
        finishedAt,
        status,
        providerStatuses:
          input.mode === 'replay'
            ? [
                // replay 只读本地 dailyBar，不以 market adapter 名义上报
                ...(needsQuote || needsDailyBars
                  ? [{ provider: 'local:daily-bars', ok: failures.length === 0 }]
                  : []),
              ]
            : [
                ...(needsQuote
                  ? [{ provider: ctx.adapters.market.name, ok: failures.length === 0 }]
                  : []),
                ...(needsDailyBars
                  ? [
                      {
                        provider: `${ctx.adapters.market.name}:daily-bars`,
                        ok: failures.length === 0,
                      },
                    ]
                  : []),
              ],
        summary: {
          schemaVersion: 3,
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
        },
        ...(error === undefined ? {} : { error }),
      });
      if (input.persist) {
        await ctx.repos.strategyRun.commitRun({ run, results, signals });
        try {
          await saveObservationCandidates(
            signals.flatMap((signal) =>
              observationsForStrategySignal(
                signal,
                baselineByStock.get(signal.stockId),
                finishedAt,
              ),
            ),
            ctx.repos.signalObservation,
          );
        } catch (observationError) {
          ctx.logger.warn('run_strategy: 后续表现观测候选写入失败，运行结果已提交', {
            runId,
            error:
              observationError instanceof Error
                ? observationError.message
                : String(observationError),
          });
        }
      }
      return { run, results, signals, persisted: input.persist };
    } catch (runError) {
      if (input.persist && startedRun !== undefined) {
        const stored = await ctx.repos.strategyRun.findRunById(startedRun.id);
        if (stored?.status === 'running') {
          const finishedAt = ctx.clock();
          const failed = StrategyRunSchema.parse({
            ...startedRun,
            finishedAt: finishedAt < startedRun.startedAt ? startedRun.startedAt : finishedAt,
            status: 'failed',
            error: runError instanceof Error ? runError.message : String(runError),
          });
          await ctx.repos.strategyRun.commitRun({ run: failed, results: [], signals: [] });
        }
      }
      throw runError;
    } finally {
      if (input.persist) {
        await ctx.repos.strategyRun.releaseRunLease({
          strategyId: input.strategyId,
          strategyVersionId: version.id,
          owner: leaseOwner,
        });
      }
    }
  },
});
