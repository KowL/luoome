import type {
  LimitUpMarketManagerLike,
  LimitUpMarketQuery,
  LimitUpMarketResultLike,
  LimitUpMarketSnapshot,
  Logger,
} from '@luoome/core';
import { assertLimitUpMarketInvariants } from '@luoome/core';

import type { LimitUpMarketSections } from '../fuyao/limit-up-market.js';
import { LRU } from '../limit-up-ladder/lru.js';

/**
 * 涨停市场看板 manager。
 *
 * 对齐 sector-quote / news 的最简错误模型（单源、无 fallback）：
 * - 三个维度独立可达：单维失败 → 该维 null + warning token，其余照常返回；
 *   **三维全失败**才视为整体 adapter_error（否则页面会静默显示空看板）
 * - 缓存 key = date，TTL 60s：页面刷新频率远低于上游限流阈值，且盘后快照不会变
 * - 空池（盘前 / 非交易日）不是错误：正常返回 + warnings=['empty-pool']
 *
 * warning token 保持机器可读（UI 负责文案），错误原因写日志，不塞进 token。
 */

export interface LimitUpMarketPrimarySource {
  readonly name: string;
  fetchMarket(date: string): Promise<LimitUpMarketSections>;
}

interface ManagerOptions {
  readonly primary: LimitUpMarketPrimarySource;
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

  private readonly primary: LimitUpMarketPrimarySource;
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private readonly cache: LRU<string, LimitUpMarketSnapshot>;
  private readonly cacheTtlMs: number;

  constructor(opts: ManagerOptions) {
    this.primary = opts.primary;
    this.sources = [opts.primary.name];
    this.logger = opts.logger;
    this.clock = opts.clock;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cache = new LRU<string, LimitUpMarketSnapshot>(16);
  }

  async fetchMarket(query: LimitUpMarketQuery): Promise<LimitUpMarketResultLike> {
    const cached = this.cache.get(query.date);
    if (cached !== undefined) return { ok: true, data: cached };

    const sections = await this.primary.fetchMarket(query.date);
    const { pool, statistics, ladder } = sections;
    if (pool === null && statistics === null && ladder === null) {
      const causes = [sections.poolError, sections.statisticsError, sections.ladderError]
        .filter((message): message is string => message !== null)
        .join('; ');
      this.logger.warn('limit-up-market 三个端点全部失败', {
        source: this.primary.name,
        date: query.date,
        causes,
      });
      return errorResult(`所有涨停市场端点失败：${causes}`);
    }

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
        this.logger.warn(`limit-up-market ${token} 拉取失败`, {
          source: this.primary.name,
          date: query.date,
          error: message,
        });
      }
    }

    const snapshot: LimitUpMarketSnapshot = {
      date: query.date,
      source: this.primary.name,
      asOf: this.clock(),
      dataAsOf: sections.dataAsOf,
      pool,
      statistics,
      ladder,
      warnings,
    };
    assertLimitUpMarketInvariants(snapshot);
    this.cache.set(query.date, snapshot, this.cacheTtlMs);
    return { ok: true, data: snapshot };
  }
}
