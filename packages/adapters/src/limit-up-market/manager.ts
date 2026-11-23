import type {
  LimitUpMarketManagerLike,
  LimitUpMarketQuery,
  LimitUpMarketResultLike,
  LimitUpMarketSnapshot,
  Logger,
  SourceErrorKind,
  SourceStatus,
} from '@luoome/core';
import { assertLimitUpMarketInvariants } from '@luoome/core';

import type { LimitUpMarketSections } from '../fuyao/limit-up-market.js';
import { LRU } from '../limit-up-ladder/lru.js';
import { sourceErrorKindOf } from '../source-error.js';
import { sourceLabel } from '../source-registry.js';

/**
 * 涨停市场看板 manager。
 *
 * 对齐 sector-quote / news 的最简错误模型：
 * - 多源按配置顺序回退：某源三个维度全失败才换下一个源，全失败才整体报错
 * - 三个维度独立可达：单维失败 → 该维 null + warning token，其余照常返回；
 *   **三维全失败**才视为整体 adapter_error（否则页面会静默显示空看板）
 * - 缓存 key = date，TTL 60s：页面刷新频率远低于上游限流阈值，且盘后快照不会变
 * - 空池（盘前 / 非交易日）不是错误：正常返回 + warnings=['empty-pool']
 * - status() 记录每个源的真实尝试 / 成功 / 失败，不把未配置的源伪装成 healthy
 *
 * warning token 保持机器可读（UI 负责文案），错误原因写日志，不塞进 token。
 */

export interface LimitUpMarketPrimarySource {
  readonly name: string;
  fetchMarket(date: string): Promise<LimitUpMarketSections>;
}

interface ManagerOptions {
  readonly primaries: readonly LimitUpMarketPrimarySource[];
  readonly logger: Logger;
  readonly clock: () => Date;
  readonly cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;

function errorResult(message: string): LimitUpMarketResultLike {
  return {
    ok: false,
    error: {
      kind: 'adapter_error',
      adapter: 'limit-up-market',
      message,
      recoverable: false,
    },
  };
}

export class LimitUpMarketManager implements LimitUpMarketManagerLike {
  readonly name = 'limit-up-market' as const;
  readonly sources: readonly string[];

  private readonly primaries: readonly LimitUpMarketPrimarySource[];
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private readonly cache: LRU<string, LimitUpMarketSnapshot>;
  private readonly cacheTtlMs: number;
  private readonly observations = new Map<
    string,
    {
      lastAttemptAt?: Date;
      lastSuccessAt?: Date;
      dataAsOf?: Date;
      lastErrorKind?: SourceErrorKind;
    }
  >();

  constructor(opts: ManagerOptions) {
    if (opts.primaries.length === 0) throw new Error('limit-up-market 至少需要一个数据源');
    this.primaries = opts.primaries;
    this.sources = opts.primaries.map((primary) => primary.name);
    this.logger = opts.logger;
    this.clock = opts.clock;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cache = new LRU<string, LimitUpMarketSnapshot>(16);
  }

  status(): readonly SourceStatus[] {
    return this.primaries.map((primary) => ({
      dataset: 'limit-up-market',
      source: primary.name,
      coverage: ['CN_A_SHARES_SH_SZ'],
      capabilityEnabled: true,
      configurationReady: true,
      ...(this.observations.get(primary.name) ?? {}),
    }));
  }

  private observationOf(name: string) {
    return this.observations.get(name) ?? {};
  }

  async fetchMarket(query: LimitUpMarketQuery): Promise<LimitUpMarketResultLike> {
    const cached = this.cache.get(query.date);
    if (cached !== undefined) return { ok: true, data: cached };

    const failures: string[] = [];
    for (const primary of this.primaries) {
      const observation = this.observationOf(primary.name);
      this.observations.set(primary.name, observation);
      observation.lastAttemptAt = this.clock();
      const sections = await this.sectionsOf(primary, query.date, failures);
      if (sections === null) continue;
      const snapshot = this.buildSnapshot(primary.name, query.date, sections);
      observation.lastSuccessAt = this.clock();
      delete observation.lastErrorKind;
      if (sections.dataAsOf !== null) observation.dataAsOf = sections.dataAsOf;
      this.cache.set(query.date, snapshot, this.cacheTtlMs);
      return { ok: true, data: snapshot };
    }

    return errorResult(
      `所有涨停市场源均失败（${this.sources
        .map((source) => sourceLabel(source))
        .join(' → ')}）：${failures.join('; ')}`,
    );
  }

  private async sectionsOf(
    primary: LimitUpMarketPrimarySource,
    date: string,
    failures: string[],
  ): Promise<LimitUpMarketSections | null> {
    let sections: LimitUpMarketSections;
    try {
      sections = await primary.fetchMarket(date);
    } catch (error) {
      const observation = this.observationOf(primary.name);
      observation.lastErrorKind = sourceErrorKindOf(error);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('limit-up-market source failed', {
        source: primary.name,
        date,
        error: message,
      });
      failures.push(`${primary.name}: ${message}`);
      return null;
    }
    const { pool, statistics, ladder } = sections;
    if (pool !== null || statistics !== null || ladder !== null) return sections;
    const causes = [sections.poolError, sections.statisticsError, sections.ladderError]
      .filter((message): message is string => message !== null)
      .join('; ');
    this.observationOf(primary.name).lastErrorKind = 'upstream_error';
    this.logger.warn('limit-up-market 三个端点全部失败', {
      source: primary.name,
      date,
      causes,
    });
    failures.push(`${primary.name}: ${causes}`);
    return null;
  }

  private buildSnapshot(
    source: string,
    date: string,
    sections: LimitUpMarketSections,
  ): LimitUpMarketSnapshot {
    const { pool, statistics, ladder } = sections;
    const warnings: string[] = [];
    if (pool === null) warnings.push('pool-unavailable');
    else if (pool.total === 0) warnings.push('empty-pool');
    if (statistics === null) warnings.push('statistics-unavailable');
    else if (statistics.limitUpStockCount === 0) warnings.push('empty-statistics');
    if (ladder === null) warnings.push('ladder-unavailable');

    for (const [token, message] of [
      ['pool', sections.poolError],
      ['statistics', sections.statisticsError],
      ['ladder', sections.ladderError],
    ] as const) {
      if (message !== null) {
        this.logger.warn(`limit-up-market ${token} 拉取失败`, { source, date, error: message });
      }
    }

    const snapshot: LimitUpMarketSnapshot = {
      date,
      source,
      asOf: this.clock(),
      dataAsOf: sections.dataAsOf,
      pool,
      statistics,
      ladder,
      warnings,
    };
    assertLimitUpMarketInvariants(snapshot);
    return snapshot;
  }
}
