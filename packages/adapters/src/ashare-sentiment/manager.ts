import {
  type AShareSentimentManagerLike,
  type AShareSentimentSnapshot,
  AShareSentimentSnapshotSchema,
  assertAShareSentimentSnapshotInvariants,
  type DataProvenance,
  isHoliday,
  isWeekend,
  type Logger,
  type MarketDataAdapterLike,
  type MarketSnapshot,
} from '@luoome/core';

import type {
  AShareSentimentRawEntry,
  AShareSentimentRawPool,
  AShareSentimentRawSnapshot,
  AShareSentimentSource,
} from './types.js';

interface ManagerOptions {
  readonly sources: readonly [AShareSentimentSource, ...AShareSentimentSource[]];
  readonly clock: () => Date;
  readonly logger: Logger;
  readonly ttlMs?: number;
  /** 真实全市场行情快照；宽度只在存在完整性信封时计算。 */
  readonly market?: MarketDataAdapterLike;
}

interface SelectedPool {
  readonly pool: AShareSentimentRawPool;
  readonly provider: string;
  readonly fallbackFrom?: string;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly snapshot: AShareSentimentSnapshot;
}

const unavailableProvenance = (
  provider: string,
  now: Date,
  errorKind: string,
  errorMessage: string,
): DataProvenance => ({
  provider,
  observedAt: now,
  fetchedAt: now,
  freshness: 'unavailable',
  errorKind,
  errorMessage,
});

const provenanceFor = (selected: SelectedPool): DataProvenance => {
  if (selected.pool.ok) {
    return {
      provider: selected.provider,
      observedAt: selected.pool.observedAt,
      fetchedAt: selected.pool.fetchedAt,
      freshness: 'fresh',
      ...(selected.fallbackFrom === undefined ? {} : { fallbackFrom: selected.fallbackFrom }),
    };
  }
  return unavailableProvenance(
    selected.provider,
    selected.pool.fetchedAt,
    selected.pool.errorKind,
    selected.pool.errorMessage,
  );
};

const failedPool = (now: Date, errorKind: 'invalid_response' | 'network_error', message: string) =>
  ({
    ok: false,
    fetchedAt: now,
    errorKind,
    errorMessage: message,
  }) as const;

const dedupe = (entries: readonly AShareSentimentRawEntry[]): AShareSentimentRawEntry[] => [
  ...new Map(entries.map((entry) => [entry.stockId, entry])).values(),
];

const countThemes = (
  entries: readonly AShareSentimentRawEntry[],
  getTags: (entry: AShareSentimentRawEntry) => readonly string[],
): { name: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of new Set(
      getTags(entry)
        .map((value) => value.trim())
        .filter(Boolean),
    )) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort(
      (left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'),
    );
};

const dateAsShanghaiNoon = (date: string): Date => new Date(`${date}T12:00:00+08:00`);

export class AShareSentimentManager implements AShareSentimentManagerLike {
  readonly name = 'ashare-sentiment' as const;
  readonly sources: readonly string[];
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(private readonly options: ManagerOptions) {
    this.sources = options.sources.map((source) => source.name);
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  async fetch(input: { readonly date: string; readonly coverage: 'CN_A_SHARES_SH_SZ' }): Promise<
    | { readonly ok: true; readonly data: AShareSentimentSnapshot }
    | {
        readonly ok: false;
        readonly error: {
          readonly kind: 'invalid_input';
          readonly message: string;
          readonly recoverable: false;
        };
      }
  > {
    const calendarDate = dateAsShanghaiNoon(input.date);
    if (isWeekend(calendarDate) || isHoliday(calendarDate)) {
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          message: `${input.date} 不是可确认的 A 股交易日`,
          recoverable: false,
        },
      };
    }

    const key = `${input.date}|${input.coverage}`;
    const now = this.options.clock();
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > now.getTime()) {
      return { ok: true, data: cached.snapshot };
    }

    const primaryName = this.options.sources[0].name;
    let sealed: SelectedPool | undefined;
    let broken: SelectedPool | undefined;
    for (const source of this.options.sources) {
      let raw: AShareSentimentRawSnapshot;
      try {
        raw = await source.fetch(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger.warn('ashare sentiment source failed', {
          source: source.name,
          error: message,
        });
        const failure = failedPool(this.options.clock(), 'network_error', message);
        sealed ??= { pool: failure, provider: `${source.name}/limit-up` };
        broken ??= { pool: failure, provider: `${source.name}/broken-board` };
        continue;
      }
      const validEnvelope = raw.date === input.date && raw.coverage === input.coverage;
      const envelopeFailure = failedPool(
        this.options.clock(),
        'invalid_response',
        `source envelope mismatch: ${raw.date}/${raw.coverage}`,
      );
      const sourceSealed = validEnvelope ? raw.sealed : envelopeFailure;
      const sourceBroken = validEnvelope ? raw.broken : envelopeFailure;
      if (sealed === undefined || (!sealed.pool.ok && sourceSealed.ok)) {
        sealed = {
          pool: sourceSealed,
          provider: `${source.name}/limit-up`,
          ...(source.name === primaryName ? {} : { fallbackFrom: `${primaryName}/limit-up` }),
        };
      }
      if (broken === undefined || (!broken.pool.ok && sourceBroken.ok)) {
        broken = {
          pool: sourceBroken,
          provider: `${source.name}/broken-board`,
          ...(source.name === primaryName ? {} : { fallbackFrom: `${primaryName}/broken-board` }),
        };
      }
      if (sealed.pool.ok && broken.pool.ok) break;
    }

    sealed ??= {
      pool: failedPool(now, 'network_error', 'no sentiment source returned sealed pool'),
      provider: `${primaryName}/limit-up`,
    };
    broken ??= {
      pool: failedPool(now, 'network_error', 'no sentiment source returned broken pool'),
      provider: `${primaryName}/broken-board`,
    };
    let marketSnapshot: MarketSnapshot | undefined;
    if (this.options.market?.fetchMarketSnapshotEnvelope !== undefined) {
      try {
        marketSnapshot = await this.options.market.fetchMarketSnapshotEnvelope();
      } catch (error) {
        this.options.logger.warn('ashare sentiment market snapshot failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const snapshot = this.assemble(input.date, now, sealed, broken, marketSnapshot);
    this.cache.set(key, { snapshot, expiresAt: now.getTime() + this.ttlMs });
    return { ok: true, data: snapshot };
  }

  private assemble(
    date: string,
    now: Date,
    sealed: SelectedPool,
    broken: SelectedPool,
    marketSnapshot?: MarketSnapshot,
  ): AShareSentimentSnapshot {
    const sealedEntries = sealed.pool.ok ? dedupe(sealed.pool.entries) : [];
    const sealedIds = new Set(sealedEntries.map((entry) => entry.stockId));
    const brokenEntries = broken.pool.ok
      ? dedupe(broken.pool.entries).filter((entry) => !sealedIds.has(entry.stockId))
      : [];
    const limitUpProvenance = [provenanceFor(sealed), provenanceFor(broken)];
    const bothComplete = sealed.pool.ok && broken.pool.ok;
    const oneComplete = sealed.pool.ok || broken.pool.ok;
    const limitUpWarnings = [sealed, broken]
      .filter((selected) => !selected.pool.ok)
      .map((selected) => (selected.pool.ok ? '' : selected.pool.errorMessage));

    const boardDistribution: Record<string, number> = {};
    for (const entry of sealedEntries) {
      const key = String(entry.ladderLevel);
      boardDistribution[key] = (boardDistribution[key] ?? 0) + 1;
    }
    const maxLadderLevel = sealedEntries.reduce(
      (maximum, entry) => Math.max(maximum, entry.ladderLevel),
      0,
    );
    const leaders = [...sealedEntries]
      .sort(
        (left, right) =>
          right.ladderLevel - left.ladderLevel ||
          (right.sealAmount ?? -1) - (left.sealAmount ?? -1) ||
          left.stockId.localeCompare(right.stockId),
      )
      .slice(0, 10)
      .map((entry) => ({
        stockId: entry.stockId,
        name: entry.name,
        ladderLevel: entry.ladderLevel,
        sealAmount: entry.sealAmount,
        openCount: entry.openCount,
      }));
    const totalSealAmount = sealedEntries.some((entry) => entry.sealAmount === null)
      ? null
      : sealedEntries.reduce((total, entry) => total + (entry.sealAmount ?? 0), 0);
    const allEntries = dedupe([...sealedEntries, ...brokenEntries]);
    const industries = countThemes(allEntries, (entry) =>
      entry.industry === undefined ? [] : [entry.industry],
    );
    const concepts = countThemes(allEntries, (entry) => entry.concepts);
    const successfulObservedAt = [sealed.pool, broken.pool]
      .filter((pool): pool is Extract<AShareSentimentRawPool, { readonly ok: true }> => pool.ok)
      .map((pool) => pool.observedAt.getTime());
    const dataAsOf =
      successfulObservedAt.length === 0 ? now : new Date(Math.min(...successfulObservedAt));

    const breadthItems = marketSnapshot?.items.filter((item) => item.changePct !== undefined) ?? [];
    const breadthComplete =
      marketSnapshot?.completeness.complete && breadthItems.length === marketSnapshot.items.length;
    const breadthStatus =
      breadthItems.length === 0 ? 'unavailable' : breadthComplete ? 'complete' : 'partial';
    const breadthWarnings = [
      ...(marketSnapshot === undefined
        ? ['market snapshot completeness envelope unavailable']
        : []),
      ...(marketSnapshot !== undefined && !marketSnapshot.completeness.complete
        ? [
            `market snapshot incomplete: expected=${marketSnapshot.completeness.expectedCount} received=${marketSnapshot.completeness.receivedCount}`,
          ]
        : []),
      ...(marketSnapshot !== undefined && breadthItems.length < marketSnapshot.items.length
        ? [
            `breadth changePct missing for ${marketSnapshot.items.length - breadthItems.length} stocks`,
          ]
        : []),
    ];
    const breadthProvenance: DataProvenance =
      marketSnapshot === undefined
        ? unavailableProvenance(
            'luoome/market-snapshot',
            now,
            'incomplete_coverage',
            'market snapshot completeness envelope is unavailable',
          )
        : {
            provider: marketSnapshot.source,
            observedAt: marketSnapshot.observedAt ?? marketSnapshot.fetchedAt,
            fetchedAt: marketSnapshot.fetchedAt,
            freshness: marketSnapshot.observedAt === undefined ? 'unknown' : 'fresh',
            ...(marketSnapshot.completeness.complete ? {} : { errorKind: 'partial_data' }),
          };
    const snapshot: AShareSentimentSnapshot = {
      date,
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf,
      indexes: {
        status: 'unavailable',
        provenance: [
          unavailableProvenance(
            'luoome/market-index',
            now,
            'not_requested',
            'index quotes are composed by get_ashare_sentiment',
          ),
        ],
        warnings: ['index quotes are composed by get_ashare_sentiment'],
      },
      breadth: {
        status: breadthStatus,
        provenance: [breadthProvenance],
        warnings: breadthWarnings,
        ...(breadthItems.length > 0
          ? {
              value: {
                advancing: breadthItems.filter((item) => (item.changePct ?? 0) > 0).length,
                declining: breadthItems.filter((item) => (item.changePct ?? 0) < 0).length,
                unchanged: breadthItems.filter((item) => (item.changePct ?? 0) === 0).length,
                total: breadthItems.length,
              },
            }
          : {}),
      },
      limitUp: {
        status: bothComplete ? 'complete' : oneComplete ? 'partial' : 'unavailable',
        provenance: limitUpProvenance,
        warnings: limitUpWarnings,
        ...(bothComplete
          ? {
              value: {
                sealedCount: sealedEntries.length,
                brokenCount: brokenEntries.length,
                brokenRate:
                  allEntries.length === 0 ? null : brokenEntries.length / allEntries.length,
                maxLadderLevel,
                totalSealAmount,
                boardDistribution,
                leaders,
              },
            }
          : {}),
      },
      themes: {
        status: oneComplete ? 'partial' : 'unavailable',
        provenance: limitUpProvenance,
        warnings: oneComplete
          ? ['concept themes unavailable from eastmoney pool']
          : limitUpWarnings,
        ...(oneComplete ? { value: { industries, concepts } } : {}),
      },
    };
    const parsed = AShareSentimentSnapshotSchema.parse(snapshot);
    assertAShareSentimentSnapshotInvariants(parsed);
    return parsed;
  }
}
