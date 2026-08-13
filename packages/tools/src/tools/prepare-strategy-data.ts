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

import { defineTool, errInvalidInput } from '../define-tool.js';

const DAY_MS = 86_400_000;
const CONCURRENCY = 8;
type CheckpointMemberInput = {
  readonly stockId: string;
  readonly status: 'available' | 'missing' | 'failed';
  readonly latestBarDate?: Date;
  readonly barCount: number;
  readonly barChecksum?: string;
  readonly provider?: string;
  readonly errorKind?: string;
  readonly vintageAvailable?: boolean;
};

export const PrepareStrategyDataInput = z.object({
  strategyId: z.string().min(1),
  asOf: z.coerce.date().optional(),
  stockIds: z.array(z.string().min(1)).max(1000).optional(),
  lookbackDays: z.number().int().min(60).max(1000).default(370),
  /** 交易日口径的新鲜度门禁；超过该滞后即进入 missing/partial，不得 provider ok。 */
  maxStalenessTradingDays: z.number().int().min(0).max(30).default(1),
  /** provider 受限并发；始终有上限，避免无界请求。 */
  concurrency: z.number().int().min(1).max(64).default(CONCURRENCY),
  /** scheduled 可复用新鲜本地投影；replay/手动刷新默认仍走 provider。 */
  cachePolicy: z.enum(['refresh', 'reuse-fresh']).default('refresh'),
  /** replay 只写 append-only revision，不能用历史 bars 覆盖当前 daily_bars 投影。 */
  persistCurrentProjection: z.boolean().default(true),
});

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

const fetchDailyBarsWithRetry = async (
  ctx: ToolContext,
  stockId: string,
  range: { readonly start: Date; readonly end: Date },
): Promise<DailyBar[]> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await ctx.adapters.market.fetchDailyBars(stockId, range);
    } catch (error) {
      lastError = error;
      if (!isRetryableProviderError(error) || attempt === 2) throw error;
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
  description: '按固定并发上限准备 Strategy 日线数据并提交可复用 checkpoint',
  sideEffect: 'external',
  input: PrepareStrategyDataInput,
  output: PrepareStrategyDataOutput,
  handler: async (input, ctx: ToolContext) => {
    const asOf = input.asOf ?? ctx.clock();
    const sync = await ctx.repos.stockUniverse.latestSnapshotAtOrBefore({
      coverage: 'CN_A_SHARES_SH_SZ',
      asOf,
    });
    const snapshotIds =
      sync === null
        ? []
        : (await ctx.repos.stockUniverse.listSnapshotMembers(sync.id)).map((stock) => stock.id);
    const stockIds = [...new Set(input.stockIds ?? snapshotIds)].sort();
    if (stockIds.length === 0)
      return errInvalidInput('prepare_strategy_data 需要非空 PIT StockUniverse');
    const universeSyncId =
      sync?.id ?? `explicit:${createHash('sha256').update(stockIds.join(',')).digest('hex')}`;
    const checkpointId = `strategy-data-checkpoint-${globalThis.crypto.randomUUID()}`;
    const startedAt = ctx.clock();
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
    const prepared = await mapWithConcurrency(
      stockIds,
      input.concurrency,
      async (stockId): Promise<CheckpointMemberInput> => {
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
            : (await fetchDailyBarsWithRetry(ctx, stockId, range)).filter(
                (bar): bar is DailyBar => bar.stockId === stockId,
              );
          const dataProvider = reuseCache ? 'local:daily-bars' : ctx.adapters.market.name;
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
            if (!reuseCache) {
              if (input.persistCurrentProjection) await ctx.repos.dailyBar.saveMany(bars);
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
          } satisfies CheckpointMemberInput;
        } catch (error) {
          return {
            stockId,
            status: 'failed' as const,
            barCount: 0,
            barChecksum: '',
            provider: ctx.adapters.market.name,
            errorKind: error instanceof Error ? error.name : 'provider_error',
          } satisfies CheckpointMemberInput;
        }
      },
    );
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
          fallbackUsed: false,
          freshness: providerFreshness,
          ...(providerDataAsOf === undefined ? {} : { dataAsOf: providerDataAsOf }),
          errorKinds: [...new Set(prepared.flatMap((member) => member.errorKind ?? []))],
        },
      ],
      startedAt,
      finishedAt,
    });
    await ctx.repos.strategyDataCheckpoint.commit({
      checkpoint,
      members: prepared.map((member) => ({ checkpointId: checkpoint.id, ...member })),
    });
    return { checkpoint, members: prepared };
  },
});
