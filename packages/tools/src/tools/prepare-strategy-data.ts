import { createHash } from 'node:crypto';
import {
  type DailyBar,
  type DailyBarRevision,
  dateInShanghai,
  isHoliday,
  isWeekend,
  StrategyDataCheckpointSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const DAY_MS = 86_400_000;
const monotonicNow = (): number =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();

const roundedMs = (value: number): number => Math.round(Math.max(0, value) * 100) / 100;

const percentileMs = (values: readonly number[], percentile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1));
  return roundedMs(sorted[index] ?? 0);
};

const latencySummary = (values: readonly number[]) => ({
  samples: values.length,
  p50Ms: percentileMs(values, 0.5),
  p95Ms: percentileMs(values, 0.95),
  maxMs: roundedMs(Math.max(0, ...values)),
});

type CheckpointMemberInput = {
  readonly stockId: string;
  readonly status: 'available' | 'missing' | 'failed';
  readonly latestBarDate?: Date;
  readonly barCount: number;
  readonly barChecksum?: string;
  readonly provider?: string;
  readonly errorKind?: string;
  readonly vintageAvailable?: boolean;
  readonly durationMs: number;
};

export const PrepareStrategyDataInput = z.object({
  strategyId: z.string().min(1),
  asOf: z.coerce.date().optional(),
  /**
   * PIT universe 的可见时点；历史 replay 的交易日 key 通常是 UTC 午夜，
   * 但目录 snapshot 可能在该交易日盘中固化，不能因此被午夜查询漏掉。
   */
  universeAsOf: z.coerce.date().optional(),
  stockIds: z.array(z.string().min(1)).max(1000).optional(),
  /** retry 只重取该 checkpoint 中 status=failed 的成员，再提交完整成员集合。 */
  retryCheckpointId: z.string().min(1).optional(),
  lookbackDays: z.number().int().min(60).max(1000).default(370),
  /** 交易日口径的新鲜度门禁；超过该滞后即进入 missing/partial，不得 provider ok。 */
  maxStalenessTradingDays: z.number().int().min(0).max(30).default(1),
  /** scheduled 可复用新鲜本地投影；replay/手动刷新默认仍走 provider。 */
  cachePolicy: z.enum(['refresh', 'reuse-fresh']).default('refresh'),
  /** replay 只写 append-only revision，不能用历史 bars 覆盖当前 daily_bars 投影。 */
  persistCurrentProjection: z.boolean().default(true),
  /** 外部 provider 的有界并发与失败预算。 */
  concurrency: z.number().int().min(1).max(64).default(8),
  maxRetries: z.number().int().min(0).max(5).default(2),
  requestTimeoutMs: z.number().int().min(500).max(120_000).default(20_000),
});

export const PrepareStrategyDataPerformanceSchema = z.object({
  memberLatencyMs: z.object({
    samples: z.number().int().nonnegative(),
    p50Ms: z.number().finite().nonnegative(),
    p95Ms: z.number().finite().nonnegative(),
    maxMs: z.number().finite().nonnegative(),
  }),
  wallDurationMs: z.number().finite().nonnegative(),
});
export type PrepareStrategyDataPerformance = z.infer<typeof PrepareStrategyDataPerformanceSchema>;

export const PrepareStrategyDataOutput = z.object({
  checkpoint: StrategyDataCheckpointSchema,
  members: z.array(
    z.object({
      stockId: z.string(),
      status: z.enum(['available', 'missing', 'failed']),
      barCount: z.number().int().nonnegative(),
      latestBarDate: z.coerce.date().optional(),
      provider: z.string().optional(),
      errorKind: z.string().optional(),
    }),
  ),
  /** 真实成员请求延迟，供性能门禁审计；不含估算或 mock 样本。 */
  performance: PrepareStrategyDataPerformanceSchema,
});

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (item !== undefined) result[index] = await fn(item);
      }
    }),
  );
  return result;
};

const isRetryableProviderError = (error: unknown): boolean =>
  /timeout|timed out|connection reset|econnreset|rate.?limit|\b429\b/i.test(
    error instanceof Error ? error.message : String(error),
  );

const providerErrorKind = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const stable = message.match(
    /\b(provider_timeout|no_data|unsupported_[a-z_]+|invalid[_-]payload|rate[_-]?limit)\b/i,
  )?.[1];
  return stable?.toLowerCase() ?? (error instanceof Error ? error.name : 'provider_error');
};

const fetchDailyBarsWithRetry = async (
  ctx: ToolContext,
  stockId: string,
  range: { readonly start: Date; readonly end: Date },
  options: { readonly maxRetries: number; readonly timeoutMs: number },
): Promise<DailyBar[]> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          ctx.adapters.market.fetchDailyBars(stockId, range),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`provider_timeout: daily bars ${stockId}`)),
              options.timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableProviderError(error) || attempt === options.maxRetries) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const shanghaiDay = (date: Date): Date => new Date(`${dateInShanghai(date)}T00:00:00.000Z`);

const dailyBarContentHash = (
  bar: Pick<DailyBar, 'open' | 'high' | 'low' | 'close' | 'volume' | 'source'>,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        source: bar.source,
      }),
    )
    .digest('hex');

const latestRevisionByDate = (
  revisions: readonly DailyBarRevision[],
): Map<string, DailyBarRevision> => {
  const latest = new Map<string, DailyBarRevision>();
  for (const revision of revisions) {
    const key = revision.date.toISOString();
    const previous = latest.get(key);
    if (
      previous === undefined ||
      revision.recordedAt.getTime() > previous.recordedAt.getTime() ||
      (revision.recordedAt.getTime() === previous.recordedAt.getTime() &&
        revision.contentHash.localeCompare(previous.contentHash) > 0)
    ) {
      latest.set(key, revision);
    }
  }
  return latest;
};

const revisionMatchesBar = (bar: DailyBar, revision: DailyBarRevision): boolean =>
  revision.contentHash === dailyBarContentHash(bar) &&
  revision.open === bar.open &&
  revision.high === bar.high &&
  revision.low === bar.low &&
  revision.close === bar.close &&
  revision.volume === bar.volume &&
  revision.source === bar.source;

const tradingDayLag = (latest: Date | undefined, asOf: Date): number | undefined => {
  if (latest === undefined) return undefined;
  const from = shanghaiDay(latest);
  const to = shanghaiDay(asOf);
  if (from.getTime() >= to.getTime()) return 0;
  const cursor = new Date(from.getTime() + DAY_MS);
  let days = 0;
  while (cursor.getTime() <= to.getTime()) {
    if (!isWeekend(cursor) && !isHoliday(cursor)) days += 1;
    cursor.setTime(cursor.getTime() + DAY_MS);
  }
  return days;
};

export const prepareStrategyDataTool = defineTool({
  name: 'prepare_strategy_data',
  description: '按配置化并发、超时和重试预算准备 Strategy 日线数据并提交可复用 checkpoint',
  sideEffect: 'external',
  input: PrepareStrategyDataInput,
  output: PrepareStrategyDataOutput,
  handler: async (input, ctx: ToolContext) => {
    const retryBase =
      input.retryCheckpointId === undefined
        ? null
        : await ctx.repos.strategyDataCheckpoint.findById(input.retryCheckpointId);
    if (input.retryCheckpointId !== undefined && retryBase === null) {
      return errNotFound('StrategyDataCheckpoint', input.retryCheckpointId);
    }
    if (retryBase?.status === 'running') {
      return errInvalidInput('retry checkpoint 仍在运行中');
    }
    if (retryBase !== null && input.stockIds !== undefined) {
      return errInvalidInput('retry checkpoint 不能同时指定 stockIds');
    }
    const retryBaseMembers =
      retryBase === null
        ? []
        : [...(await ctx.repos.strategyDataCheckpoint.listMembers(retryBase.id))];
    const retryIds = retryBaseMembers
      .filter((member) => member.status === 'failed')
      .map((member) => member.stockId)
      .sort();
    if (retryBase !== null && retryIds.length === 0) {
      return errInvalidInput('retry checkpoint 没有 status=failed 的成员');
    }
    const asOf = retryBase?.dataAsOf ?? input.asOf ?? ctx.clock();
    const universeAsOf = input.universeAsOf ?? asOf;
    const sourceStatuses =
      typeof ctx.adapters.market.marketSourceStatus === 'function'
        ? ctx.adapters.market.marketSourceStatus()
        : [];
    const primaryDailyBarSource = sourceStatuses.find(
      (source) => source.dataset === 'daily-bars' && source.capabilityEnabled,
    )?.source;
    const sync =
      retryBase === null
        ? await ctx.repos.stockUniverse.latestSnapshotAtOrBefore({
            coverage: 'CN_A_SHARES_SH_SZ',
            asOf: universeAsOf,
          })
        : null;
    const snapshotIds =
      retryBase === null
        ? sync === null
          ? []
          : (await ctx.repos.stockUniverse.listSnapshotMembers(sync.id)).map((stock) => stock.id)
        : retryBaseMembers.map((member) => member.stockId);
    const stockIds = [...new Set(input.stockIds ?? snapshotIds)].sort();
    if (stockIds.length === 0)
      return errInvalidInput('prepare_strategy_data 需要非空 PIT StockUniverse');
    const universeSyncId =
      retryBase?.universeSyncId ??
      sync?.id ??
      `explicit:${createHash('sha256').update(stockIds.join(',')).digest('hex')}`;
    const checkpointId = `strategy-data-checkpoint-${globalThis.crypto.randomUUID()}`;
    const startedAt = ctx.clock();
    const operationStartedAt = monotonicNow();
    await ctx.repos.strategyDataCheckpoint.saveStarted({
      id: checkpointId,
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf: asOf,
      status: 'running',
      vintageStatus: 'not-applicable',
      universeSyncId,
      requestedCount: stockIds.length,
      availableCount: 0,
      failedCount: 0,
      memberChecksum: createHash('sha256').update(JSON.stringify(stockIds)).digest('hex'),
      dataChecksum: 'pending',
      providerStatuses: [],
      startedAt,
    });
    const fetched = await mapWithConcurrency(
      retryBase === null ? stockIds : retryIds,
      input.concurrency,
      async (stockId): Promise<CheckpointMemberInput> => {
        const memberStartedAt = monotonicNow();
        try {
          const range = {
            start: new Date(asOf.getTime() - input.lookbackDays * DAY_MS),
            end: asOf,
          };
          const cachedBars =
            input.cachePolicy === 'reuse-fresh' && input.persistCurrentProjection
              ? await ctx.repos.dailyBar.findInRange(stockId, range.start, range.end)
              : [];
          const cachedLatestBarDate = cachedBars.reduce<Date | undefined>(
            (latest, bar) => (latest === undefined || bar.date > latest ? bar.date : latest),
            undefined,
          );
          const reuseCache =
            cachedBars.length > 0 &&
            (tradingDayLag(cachedLatestBarDate, asOf) ?? Number.POSITIVE_INFINITY) <=
              input.maxStalenessTradingDays;
          const bars = reuseCache
            ? cachedBars
            : (
                await fetchDailyBarsWithRetry(ctx, stockId, range, {
                  maxRetries: input.maxRetries,
                  timeoutMs: input.requestTimeoutMs,
                })
              ).filter((bar): bar is DailyBar => bar.stockId === stockId);
          const barProviders = [...new Set(bars.map((bar) => bar.source))].sort();
          const dataProvider = reuseCache
            ? 'local:daily-bars'
            : barProviders.length === 0
              ? ctx.adapters.market.name
              : barProviders.length === 1
                ? (barProviders[0] as string)
                : `mixed:${barProviders.join('+')}`;
          const latestBarDate = bars.reduce<Date | undefined>(
            (latest, bar) => (latest === undefined || bar.date > latest ? bar.date : latest),
            undefined,
          );
          const stale =
            bars.length === 0 ||
            (tradingDayLag(latestBarDate, asOf) ?? Number.POSITIVE_INFINITY) >
              input.maxStalenessTradingDays;
          const firstBarDate = bars.reduce<Date | undefined>(
            (first, bar) => (first === undefined || bar.date < first ? bar.date : first),
            undefined,
          );
          const vintageRevisions =
            !input.persistCurrentProjection &&
            firstBarDate !== undefined &&
            latestBarDate !== undefined
              ? await ctx.repos.dailyBar.listRevisions({
                  stockId,
                  from: firstBarDate,
                  to: latestBarDate,
                  recordedAt: asOf,
                })
              : undefined;
          const vintageRevisionByDate =
            vintageRevisions === undefined ? undefined : latestRevisionByDate(vintageRevisions);
          const vintageAvailable =
            vintageRevisionByDate === undefined
              ? undefined
              : bars.every((bar) => {
                  const revision = vintageRevisionByDate.get(bar.date.toISOString());
                  return revision !== undefined && revisionMatchesBar(bar, revision);
                });
          if (bars.length > 0) {
            if (!reuseCache && input.persistCurrentProjection) {
              await ctx.repos.dailyBar.saveMany(bars);
            }
            await ctx.repos.dailyBar.saveRevisions(
              bars.map((bar) => ({
                stockId: bar.stockId,
                date: bar.date,
                contentHash: dailyBarContentHash(bar),
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
                source: bar.source,
                recordedAt: startedAt,
              })),
            );
          }
          return {
            stockId,
            status: stale ? ('missing' as const) : ('available' as const),
            barCount: bars.length,
            barChecksum: createHash('sha256')
              .update(
                JSON.stringify(
                  bars.map((bar) => ({
                    date: bar.date,
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume,
                    source: bar.source,
                  })),
                ),
              )
              .digest('hex'),
            ...(latestBarDate === undefined ? {} : { latestBarDate }),
            provider: dataProvider,
            ...(stale ? { errorKind: 'stale_data' } : {}),
            ...(vintageAvailable === undefined ? {} : { vintageAvailable }),
            durationMs: roundedMs(monotonicNow() - memberStartedAt),
          } satisfies CheckpointMemberInput;
        } catch (error) {
          return {
            stockId,
            status: 'failed' as const,
            barCount: 0,
            barChecksum: '',
            provider: ctx.adapters.market.name,
            errorKind: providerErrorKind(error),
            durationMs: roundedMs(monotonicNow() - memberStartedAt),
          } satisfies CheckpointMemberInput;
        }
      },
    );
    const fetchedByStock = new Map(fetched.map((member) => [member.stockId, member] as const));
    const prepared =
      retryBase === null
        ? fetched
        : stockIds.map((stockId) => {
            const refreshed = fetchedByStock.get(stockId);
            if (refreshed !== undefined) return refreshed;
            const previous = retryBaseMembers.find((member) => member.stockId === stockId);
            if (previous === undefined) {
              throw new Error(`retry checkpoint 缺少成员: ${stockId}`);
            }
            return {
              stockId,
              status: previous.status,
              ...(previous.latestBarDate === undefined
                ? {}
                : { latestBarDate: previous.latestBarDate }),
              barCount: previous.barCount,
              ...(previous.provider === undefined ? {} : { provider: previous.provider }),
              ...(previous.errorKind === undefined ? {} : { errorKind: previous.errorKind }),
              durationMs: 0,
            } satisfies CheckpointMemberInput;
          });
    const memberDurations = (retryBase === null ? prepared : fetched).map(
      (member) => member.durationMs,
    );
    const memberLatencyMs = latencySummary(memberDurations);
    const performance = {
      memberLatencyMs,
      wallDurationMs: roundedMs(monotonicNow() - operationStartedAt),
    } satisfies PrepareStrategyDataPerformance;
    const availableCount = prepared.filter((member) => member.status === 'available').length;
    const missingCount = prepared.filter((member) => member.status === 'missing').length;
    const failedCount = prepared.filter((member) => member.status === 'failed').length;
    const status =
      availableCount === 0 ? 'failed' : failedCount + missingCount > 0 ? 'partial' : 'complete';
    const finishedAt = ctx.clock();
    const providers = [
      ...new Set(prepared.map((member) => member.provider).filter((value) => value !== undefined)),
    ].sort();
    const provider =
      providers.length === 0
        ? ctx.adapters.market.name
        : providers.length === 1
          ? (providers[0] as string)
          : `mixed:${providers.join('+')}`;
    const vintageStatus = input.persistCurrentProjection
      ? 'not-applicable'
      : prepared.every((member) => member.vintageAvailable === true)
        ? 'available'
        : 'unavailable';
    const availableLatestDates = prepared.flatMap((member) =>
      member.status === 'available' && member.latestBarDate === undefined
        ? []
        : member.latestBarDate === undefined
          ? []
          : [member.latestBarDate],
    );
    const providerDataAsOf = availableLatestDates.sort(
      (left, right) => left.getTime() - right.getTime(),
    )[0];
    const providerFreshness =
      availableCount === 0
        ? ('unavailable' as const)
        : failedCount + missingCount > 0
          ? ('stale' as const)
          : ('fresh' as const);
    const fallbackUsed =
      primaryDailyBarSource !== undefined &&
      prepared.some((member) => {
        if (member.provider === undefined || member.provider === 'local:daily-bars') return false;
        const actualSources = member.provider.startsWith('mixed:')
          ? member.provider.slice('mixed:'.length).split('+')
          : [member.provider];
        return actualSources.some((source) => source !== primaryDailyBarSource);
      });
    const checkpoint = StrategyDataCheckpointSchema.parse({
      id: checkpointId,
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf: asOf,
      status,
      vintageStatus,
      universeSyncId,
      requestedCount: stockIds.length,
      availableCount,
      failedCount,
      memberChecksum: createHash('sha256').update(JSON.stringify(stockIds)).digest('hex'),
      dataChecksum: createHash('sha256')
        .update(
          JSON.stringify(
            prepared.map(({ stockId, status: memberStatus, barCount, barChecksum = '' }) => ({
              stockId,
              status: memberStatus,
              barCount,
              barChecksum,
            })),
          ),
        )
        .digest('hex'),
      providerStatuses: [
        {
          capability: 'daily-bars',
          provider,
          requested: stockIds.length,
          succeeded: availableCount,
          failed: failedCount,
          missing: prepared.filter((member) => member.status === 'missing').length,
          fallbackUsed,
          freshness: providerFreshness,
          ...(providerDataAsOf === undefined ? {} : { dataAsOf: providerDataAsOf }),
          errorKinds: [...new Set(prepared.flatMap((member) => member.errorKind ?? []))],
          latencyMs: memberLatencyMs,
        },
      ],
      startedAt,
      finishedAt,
    });
    await ctx.repos.strategyDataCheckpoint.commit({
      checkpoint,
      members: prepared.map((member) => ({ checkpointId: checkpoint.id, ...member })),
    });
    return { checkpoint, members: prepared, performance };
  },
});
