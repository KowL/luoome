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

const DAY_MS = 86_400_000;
const EVALUATION_CONCURRENCY = 8;

export const RunStrategyInput = z.object({
  strategyId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  mode: z.enum(['scan', 'replay']).default('scan'),
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
  if (
    version.strategyId !== strategy.id ||
    version.validationStatus !== 'valid' ||
    version.publishedAt === undefined
  ) {
    return errInvalidInput('run_strategy 只能运行同一 Strategy 的 published valid version');
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
    if (input.mode === 'scan' && input.asOf !== undefined) {
      return errInvalidInput(
        'mode=scan 不支持 asOf：bars 会取历史而 quote 仍是实时，时点不一致；需要历史时点请用 mode=replay + 显式 stockIds',
      );
    }
    const resolved = await resolveVersion(input.strategyId, input.versionId, ctx);
    if ('ok' in resolved) return resolved;
    const version = resolved;
    const definition = version.definition;
    const references = inspectStrategyDefinitionReferences(definition);
    if (references.validationErrors.length > 0) {
      return errInvalidInput(references.validationErrors.join('; '));
    }

    const activeStocks = await ctx.repos.stockUniverse.listCurrent({
      coverage: 'CN_A_SHARES_SH_SZ',
      status: 'active',
    });
    if (input.stockIds === undefined) {
      const successfulSync = await ctx.repos.stockUniverse.latestSuccessfulSync({
        coverage: 'CN_A_SHARES_SH_SZ',
      });
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
    const needsMeta = references.dataSources.includes('meta');
    const lookback = Math.max(1, references.requiredLookback);

    const evaluated = await mapWithConcurrency(
      candidateIds,
      EVALUATION_CONCURRENCY,
      async (
        stockId,
      ): Promise<
        | { readonly ok: true; readonly evaluation: StrategyStockEvaluation }
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
            evaluation: evaluateStrategyStock({
              strategyId: input.strategyId,
              version,
              runId,
              stockId,
              ts: dataAsOf,
              dataAsOf,
              context: {
                ...(quote === undefined ? {} : { quote }),
                indicators: computeSimpleIndicators(bars),
              },
            }),
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

    const failures = evaluated.filter(
      (item): item is Extract<(typeof evaluated)[number], { ok: false }> => !item.ok,
    );
    const successful = evaluated.flatMap((item) => (item.ok ? [item.evaluation] : []));
    const ranked = assignStableStrategyRanks(successful, definition);
    const results = ranked.map((item) => item.result);
    const signals = ranked.flatMap((item) => item.signals);
    const partialCount = ranked.filter((item) => item.partial).length;
    const finishedAt = ctx.clock();
    const status =
      candidateIds.length > 0 && failures.length === candidateIds.length
        ? 'failed'
        : failures.length > 0 || partialCount > 0 || needsMeta
          ? 'partial'
          : 'complete';
    const error =
      status === 'failed' ? `全部 ${failures.length} 个 candidate 数据准备失败` : undefined;
    const run = StrategyRunSchema.parse({
      id: runId,
      strategyId: input.strategyId,
      strategyVersionId: version.id,
      mode: input.mode,
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf,
      startedAt,
      finishedAt,
      status,
      inputSnapshot: {
        candidateStockIds: candidateIds,
        subset: input.stockIds !== undefined,
        persist: input.persist,
      },
      providerStatuses:
        input.mode === 'replay'
          ? [
              // replay 只读本地 dailyBar，不以 market adapter 名义上报
              ...(needsQuote || needsDailyBars
                ? [{ provider: 'local:daily-bars', ok: failures.length === 0 }]
                : []),
              ...(needsMeta
                ? [{ provider: 'strategy-meta', ok: false, errorKind: 'unsupported' }]
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
              ...(needsMeta
                ? [{ provider: 'strategy-meta', ok: false, errorKind: 'unsupported' }]
                : []),
            ],
      summary: {
        candidates: candidateIds.length,
        evaluated: results.length,
        selected: results.filter((result) => result.selected).length,
        signals: signals.length,
        partial: partialCount,
        failed: failures.length,
        failures: failures.slice(0, 20),
      },
      ...(error === undefined ? {} : { error }),
    });
    if (input.persist) await ctx.repos.strategyRun.commitRun({ run, results, signals });
    return { run, results, signals, persisted: input.persist };
  },
});
