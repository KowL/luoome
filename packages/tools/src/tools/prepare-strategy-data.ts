import { createHash } from 'node:crypto';
import {
  type DailyBar,
  type DailyBarRevision,
  dateInShanghai,
  isHoliday,
  isWeekend,
  latestClosedTradingDate,
  SourceErrorKindSchema,
  StrategyDataCheckpointSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput } from '../define-tool.js';
import {
  dailyBarContentHash,
  dropUnclosedBars,
  fetchDailyBarsWithRetry,
  mapWithConcurrency,
} from '../internal/daily-bar-ingestion.js';
import { excludeUntradeableStockIds } from '../internal/operational-universe.js';

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
  /**
   * 因「长期无任何日线」被剔除的成员数（全市场路径才有；显式 stockIds 不剔除）。
   *
   * 退市代码会留在行情目录里，任何源都拿不到日线；把它们留在请求集里，每轮都要
   * 为每只白拉 2–3 个源，并把覆盖率按下去。剔除是**事实判定**，不是数据填充。
   */
  untradeableExcluded: z.number().int().nonnegative(),
  /** 真实成员请求延迟，供性能门禁审计；不含估算或 mock 样本。 */
  performance: PrepareStrategyDataPerformanceSchema,
});

/**
 * 消息里的稳定 token → 规范词表。
 *
 * 只做归一化，不做猜测：`rate limit` / `rate-limit` 必须落到同一个 `rate_limited`，
 * 否则同一个故障会在 `errorKinds` 里长出三个键，分桶统计就失去意义。
 */
const normalizeStableKind = (raw: string): string => {
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
  return normalized === 'rate_limit' ? 'rate_limited' : normalized;
};

/**
 * 把一次抓取异常归到**稳定**的 errorKind。
 *
 * 三条纪律：
 * 1. **先读结构化 kind**：源客户端抛的 `SourceExecutionError` 自带 `kind` 词表，
 *    那才是事实；从 message 正则重新推断是在丢信息（adapter 已经归过类）。
 * 2. 消息正则只是**兼容兜底**，用于没有结构化 kind 的第三方/运行时异常。
 * 3. 兜底值必须是 `unclassified`。**不能**退回 `error.name`——普通 `Error` 的 name
 *    就是字符串 `"Error"`，它会以"分类"的身份写进 `errorKinds`，再被门禁、归因和
 *    报告当作事实消费，等于把「没分类」伪装成「有一个分类叫 Error」。
 */
const providerErrorKind = (error: unknown): string => {
  const structured =
    error !== null && typeof error === 'object'
      ? (error as { readonly kind?: unknown }).kind
      : undefined;
  if (typeof structured === 'string' && SourceErrorKindSchema.safeParse(structured).success) {
    return structured;
  }
  const message = error instanceof Error ? error.message : String(error);
  const stable = message.match(
    /\b(operation_cancelled|provider_timeout|no_data|unsupported_[a-z_]+|invalid[_-]payload|rate[_-]?\s?limit)\b/i,
  )?.[1];
  return stable === undefined ? 'unclassified' : normalizeStableKind(stable);
};

const shanghaiDay = (date: Date): Date => new Date(`${dateInShanghai(date)}T00:00:00.000Z`);

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

/**
 * 交易日滞后：以**最近已收盘交易日**为基准，而不是墙上时钟那天。
 * 否则 10-30 00:40 跑一轮时，10-29 的收盘 bar 会被算成「落后 1 个交易日」，
 * maxStalenessTradingDays=0 的 scheduled 周期就会把全部成员判成 stale。
 */
const tradingDayLag = (latest: Date | undefined, reference: Date): number | undefined => {
  if (latest === undefined) return undefined;
  const from = shanghaiDay(latest);
  const to = shanghaiDay(reference);
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
  requiredCapabilities: ['external', 'write'],
  input: PrepareStrategyDataInput,
  output: PrepareStrategyDataOutput,
  handler: async (input, ctx: ToolContext) => {
    const asOf = input.asOf ?? ctx.clock();
    const universeAsOf = input.universeAsOf ?? asOf;
    const sourceStatuses =
      typeof ctx.adapters.market.marketSourceStatus === 'function'
        ? ctx.adapters.market.marketSourceStatus()
        : [];
    const primaryDailyBarSource = sourceStatuses.find(
      (source) => source.dataset === 'daily-bars' && source.capabilityEnabled,
    )?.source;
    const sync = await ctx.repos.stockUniverse.latestSnapshotAtOrBefore({
      coverage: 'CN_A_SHARES_SH_SZ',
      asOf: universeAsOf,
    });
    const snapshotIds =
      sync === null
        ? []
        : (await ctx.repos.stockUniverse.listSnapshotMembers(sync.id)).map((stock) => stock.id);
    // 显式 stockIds 一律照办；只有全市场路径才剔除长期无数据的退市代码。
    const universe = await excludeUntradeableStockIds(ctx, input.stockIds ?? snapshotIds, asOf);
    const stockIds = [
      ...new Set(input.stockIds === undefined ? universe.kept : input.stockIds),
    ].sort();
    const untradeableExcluded = input.stockIds === undefined ? universe.untradeable.length : 0;
    if (stockIds.length === 0)
      return errInvalidInput('prepare_strategy_data 需要非空 PIT StockUniverse');
    const universeSyncId =
      sync?.id ?? `explicit:${createHash('sha256').update(stockIds.join(',')).digest('hex')}`;
    const checkpointId = `strategy-data-checkpoint-${globalThis.crypto.randomUUID()}`;
    const startedAt = ctx.clock();
    const now = startedAt;
    // 新鲜度基准 = 最近已收盘交易日；盘中/凌晨跑也不能把上一交易日的收盘 bar 判成落后。
    const referenceDay = latestClosedTradingDate(asOf);
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
    const prepared = await mapWithConcurrency(
      stockIds,
      input.concurrency,
      async (stockId): Promise<CheckpointMemberInput> => {
        const memberStartedAt = monotonicNow();
        try {
          if (ctx.abortSignal?.aborted) throw new Error('operation_cancelled');
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
            (tradingDayLag(cachedLatestBarDate, referenceDay) ?? Number.POSITIVE_INFINITY) <=
              input.maxStalenessTradingDays;
          const bars = dropUnclosedBars(
            reuseCache
              ? cachedBars
              : (
                  await fetchDailyBarsWithRetry(ctx, stockId, range, {
                    maxRetries: input.maxRetries,
                    timeoutMs: input.requestTimeoutMs,
                  })
                ).filter((bar): bar is DailyBar => bar.stockId === stockId),
            now,
          );
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
            (tradingDayLag(latestBarDate, referenceDay) ?? Number.POSITIVE_INFINITY) >
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
    const memberDurations = prepared.map((member) => member.durationMs);
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
      member.status === 'available' && member.latestBarDate !== undefined
        ? [member.latestBarDate]
        : [],
    );
    const observedLatestDates = prepared.flatMap((member) =>
      member.latestBarDate === undefined ? [] : [member.latestBarDate],
    );
    const providerDataAsOf = (
      availableLatestDates.length > 0 ? availableLatestDates : observedLatestDates
    ).sort((left, right) => left.getTime() - right.getTime())[0];
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
    return { checkpoint, members: prepared, untradeableExcluded, performance };
  },
});
