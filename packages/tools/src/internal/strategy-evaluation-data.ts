import {
  type DailyBar,
  DailyBarSchema,
  type ProviderStatus,
  type Quote,
  type StrategyDataCheckpoint,
  type StrategyDataCheckpointMember,
  type StrategyProviderCoverage,
  type ToolContext,
} from '@luoome/core';

const DAY_MS = 86_400_000;
const BATCH_QUOTE_CHUNK_SIZE = 100;

export interface StrategyEvaluationDataRequest {
  readonly stockIds: readonly string[];
  readonly dataAsOf: Date;
  readonly fetchedAt: Date;
  readonly lookback: number;
  readonly needsQuote: boolean;
  readonly needsDailyBars: boolean;
  readonly concurrency: number;
  readonly shouldContinue?: () => boolean;
}

export interface PreparedStrategyEvaluationData {
  readonly stockId: string;
  readonly bars: readonly DailyBar[];
  readonly quote?: Quote;
}

export interface StrategyEvaluationDataFailure {
  readonly stockId: string;
  readonly error: string;
}

export interface StrategyEvaluationDataBatch {
  readonly prepared: readonly PreparedStrategyEvaluationData[];
  readonly failures: readonly StrategyEvaluationDataFailure[];
}

export interface StrategyEvaluationDataAudit {
  readonly providerStatuses: readonly ProviderStatus[];
  readonly providerCoverage: readonly StrategyProviderCoverage[];
}

export interface StrategyEvaluationData {
  preloadQuotes(
    stockIds: readonly string[],
    concurrency: number,
  ): Promise<ReadonlyMap<string, Quote>>;
  load(request: StrategyEvaluationDataRequest): Promise<StrategyEvaluationDataBatch>;
  audit(
    request: StrategyEvaluationDataRequest,
    batch: StrategyEvaluationDataBatch,
  ): StrategyEvaluationDataAudit;
}

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  shouldContinue: () => boolean = () => true,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && shouldContinue()) {
      const index = next++;
      const item = items[index];
      if (item !== undefined) results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
};

const collectBatch = (
  loaded: readonly (
    | { readonly ok: true; readonly data: PreparedStrategyEvaluationData }
    | { readonly ok: false; readonly failure: StrategyEvaluationDataFailure }
  )[],
): StrategyEvaluationDataBatch => ({
  prepared: loaded.flatMap((item) => (item.ok ? [item.data] : [])),
  failures: loaded.flatMap((item) => (item.ok ? [] : [item.failure])),
});

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

const coverageErrorKinds = (
  failures: readonly StrategyEvaluationDataFailure[],
  inherited: readonly string[] = [],
  vintageUnavailable = false,
): string[] =>
  [
    ...inherited,
    ...(failures.length === 0 ? [] : ['provider_error']),
    ...(vintageUnavailable ? ['vintage_unavailable'] : []),
  ].filter((kind, index, all) => all.indexOf(kind) === index);

export const createLiveStrategyEvaluationDataAdapter = (
  ctx: ToolContext,
): StrategyEvaluationData => {
  const preloadedQuotes = new Map<string, Quote>();

  return {
    async preloadQuotes(stockIds, concurrency) {
      const chunks: string[][] = [];
      const chunkSize = Math.min(BATCH_QUOTE_CHUNK_SIZE, concurrency);
      for (let index = 0; index < stockIds.length; index += chunkSize) {
        chunks.push(stockIds.slice(index, index + chunkSize));
      }
      // batchQuote 实现可能自行并发逐股请求；串行提交小批次，确保上游并发有界。
      const chunkResults = await mapWithConcurrency(chunks, 1, async (chunk) => {
        try {
          return await ctx.adapters.market.batchQuote(chunk);
        } catch (error) {
          ctx.logger.warn(
            'run_strategy batch quote chunk failed; falling back to per-stock fetch',
            {
              chunkSize: chunk.length,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          return new Map<string, Quote>();
        }
      });
      for (const chunk of chunkResults) {
        for (const [requestedStockId, quote] of chunk) {
          preloadedQuotes.set(requestedStockId, quote);
          preloadedQuotes.set(quote.stockId, quote);
        }
      }
      return preloadedQuotes;
    },

    async load(request) {
      const loaded = await mapWithConcurrency(
        request.stockIds,
        request.concurrency,
        async (stockId) => {
          try {
            const bars = request.needsDailyBars
              ? await ctx.adapters.market.fetchDailyBars(stockId, {
                  start: new Date(
                    request.dataAsOf.getTime() - Math.max(request.lookback * 2, 30) * DAY_MS,
                  ),
                  end: request.dataAsOf,
                })
              : [];
            const quote = request.needsQuote
              ? (preloadedQuotes.get(stockId) ?? (await ctx.adapters.market.fetchQuote(stockId)))
              : undefined;
            return {
              ok: true as const,
              data: {
                stockId,
                bars,
                ...(quote === undefined ? {} : { quote }),
              },
            };
          } catch (error) {
            return {
              ok: false as const,
              failure: {
                stockId,
                error: error instanceof Error ? error.message : String(error),
              },
            };
          }
        },
        request.shouldContinue,
      );
      return collectBatch(loaded);
    },

    audit(request, batch) {
      const errorKinds = coverageErrorKinds(batch.failures);
      const providerStatuses: ProviderStatus[] = [
        ...(request.needsQuote
          ? [{ provider: ctx.adapters.market.name, ok: batch.failures.length === 0 }]
          : []),
        ...(request.needsDailyBars
          ? [
              {
                provider: `${ctx.adapters.market.name}:daily-bars`,
                ok: batch.failures.length === 0,
              },
            ]
          : []),
      ];
      const providerCoverage: StrategyProviderCoverage[] = [
        ...(request.needsQuote
          ? [
              {
                capability: 'quote' as const,
                provider: ctx.adapters.market.name,
                requested: request.stockIds.length,
                succeeded: batch.prepared.filter((item) => item.quote !== undefined).length,
                failed: batch.failures.length,
                missing: batch.prepared.filter((item) => item.quote === undefined).length,
                fallbackUsed: false,
                freshness: 'fresh' as const,
                dataAsOf: request.dataAsOf,
                errorKinds,
              },
            ]
          : []),
        ...(request.needsDailyBars
          ? [
              {
                capability: 'daily-bars' as const,
                provider: `${ctx.adapters.market.name}:daily-bars`,
                requested: request.stockIds.length,
                succeeded: batch.prepared.filter((item) => item.bars.length > 0).length,
                failed: batch.failures.length,
                missing: batch.prepared.filter((item) => item.bars.length === 0).length,
                fallbackUsed: false,
                freshness: 'fresh' as const,
                dataAsOf: request.dataAsOf,
                errorKinds,
              },
            ]
          : []),
      ];
      return { providerStatuses, providerCoverage };
    },
  };
};

export interface CheckpointStrategyEvaluationDataOptions {
  readonly ctx: ToolContext;
  readonly mode: 'scheduled' | 'replay';
  readonly checkpoint?: StrategyDataCheckpoint;
  readonly members: readonly StrategyDataCheckpointMember[];
  readonly revisionCutoff?: Date;
}

export const createCheckpointStrategyEvaluationDataAdapter = (
  options: CheckpointStrategyEvaluationDataOptions,
): StrategyEvaluationData => {
  const { ctx } = options;
  const memberByStock = new Map(options.members.map((member) => [member.stockId, member] as const));
  const dailyBarsCoverage = options.checkpoint?.providerStatuses.find(
    (coverage) => coverage.capability === 'daily-bars',
  );

  return {
    async preloadQuotes() {
      return new Map<string, Quote>();
    },

    async load(request) {
      const loaded = await mapWithConcurrency(
        request.stockIds,
        request.concurrency,
        async (stockId) => {
          if (options.mode === 'scheduled' && memberByStock.get(stockId)?.status !== 'available') {
            return {
              ok: false as const,
              failure: {
                stockId,
                error: memberByStock.get(stockId)?.errorKind ?? 'stale_data',
              },
            };
          }
          try {
            let bars: readonly DailyBar[] = [];
            if (request.needsDailyBars || request.needsQuote) {
              if (options.revisionCutoff !== undefined) {
                const revisions = await ctx.repos.dailyBar.listRevisions({
                  stockId,
                  to: request.dataAsOf,
                  recordedAt: options.revisionCutoff,
                });
                const latestByDate = new Map<string, (typeof revisions)[number]>();
                for (const revision of revisions) {
                  const key = revision.date.toISOString();
                  const previous = latestByDate.get(key);
                  if (
                    previous === undefined ||
                    revision.recordedAt.getTime() > previous.recordedAt.getTime() ||
                    (revision.recordedAt.getTime() === previous.recordedAt.getTime() &&
                      revision.contentHash.localeCompare(previous.contentHash) > 0)
                  ) {
                    latestByDate.set(key, revision);
                  }
                }
                bars = [...latestByDate.values()]
                  .sort((left, right) => left.date.getTime() - right.date.getTime())
                  .slice(-request.lookback)
                  .map((revision) =>
                    DailyBarSchema.parse({
                      stockId: revision.stockId,
                      date: revision.date,
                      open: revision.open,
                      high: revision.high,
                      low: revision.low,
                      close: revision.close,
                      volume: revision.volume,
                      adjustment: 'qfq',
                      source: revision.source,
                    }),
                  );
              } else {
                bars = await ctx.repos.dailyBar.latestBefore(
                  stockId,
                  request.dataAsOf,
                  request.lookback,
                );
              }
            }
            const latestBar = bars.at(-1);
            const quote =
              latestBar === undefined ? undefined : quoteFromDailyBar(latestBar, request.fetchedAt);
            return {
              ok: true as const,
              data: {
                stockId,
                bars,
                ...(quote === undefined ? {} : { quote }),
              },
            };
          } catch (error) {
            return {
              ok: false as const,
              failure: {
                stockId,
                error: error instanceof Error ? error.message : String(error),
              },
            };
          }
        },
        request.shouldContinue,
      );
      return collectBatch(loaded);
    },

    audit(request, batch) {
      const freshness =
        options.mode === 'scheduled' ? (dailyBarsCoverage?.freshness ?? 'unavailable') : 'stale';
      const dataAsOf =
        options.mode === 'scheduled' ? dailyBarsCoverage?.dataAsOf : request.dataAsOf;
      const unavailable = request.stockIds.filter(
        (stockId) => memberByStock.get(stockId)?.status !== 'available',
      );
      const failed =
        options.mode === 'scheduled'
          ? request.stockIds.filter((stockId) => memberByStock.get(stockId)?.status === 'failed')
              .length
          : batch.failures.length;
      const dailyBarsSucceeded =
        options.mode === 'scheduled'
          ? request.stockIds.length - unavailable.length
          : batch.prepared.filter((item) => item.bars.length > 0).length;
      const quoteSucceeded =
        options.mode === 'scheduled'
          ? request.stockIds.length - unavailable.length
          : batch.prepared.filter((item) => item.quote !== undefined).length;
      const missing =
        options.mode === 'scheduled'
          ? unavailable.length - failed
          : batch.prepared.filter((item) => item.bars.length === 0).length;
      const errorKinds = coverageErrorKinds(
        batch.failures,
        dailyBarsCoverage?.errorKinds,
        options.checkpoint?.vintageStatus === 'unavailable',
      );
      const provider = options.mode === 'scheduled' ? 'checkpoint:daily-bars' : 'local:daily-bars';
      const providerStatuses: ProviderStatus[] =
        request.needsQuote || request.needsDailyBars
          ? [
              {
                provider,
                ok: batch.failures.length === 0 && freshness === 'fresh',
                ...(options.mode === 'scheduled' && dailyBarsCoverage?.latencyMs !== undefined
                  ? { latencyMs: dailyBarsCoverage.latencyMs }
                  : {}),
              },
            ]
          : [];
      const commonCoverage = {
        provider,
        requested: request.stockIds.length,
        failed,
        missing,
        fallbackUsed: false,
        freshness,
        ...(dataAsOf === undefined ? {} : { dataAsOf }),
        errorKinds,
      };
      const providerCoverage: StrategyProviderCoverage[] = [
        ...(request.needsQuote
          ? [{ capability: 'quote' as const, ...commonCoverage, succeeded: quoteSucceeded }]
          : []),
        ...(request.needsDailyBars
          ? [
              {
                capability: 'daily-bars' as const,
                ...commonCoverage,
                succeeded: dailyBarsSucceeded,
              },
            ]
          : []),
      ];
      return { providerStatuses, providerCoverage };
    },
  };
};
