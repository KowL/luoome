import type {
  FetchSectorQuotesQuery,
  Logger,
  SectorQuoteItem,
  SourceErrorKind,
  SourceStatus,
} from '@luoome/core';

import { sourceErrorKindOf } from '../source-error.js';
import { sourceLabel } from '../source-registry.js';
import type { SectorQuoteAdapterLike, SectorQuoteRawItem, SectorQuoteResult } from './types.js';

/**
 * SectorQuoteManager。
 *
 * 对齐 news / limit-up-market 的有序多源回退：
 * - 板块行情是实时快照，不涉及交易日历
 * - 按 LUOOME_SECTOR_QUOTE_SOURCES 的顺序逐源尝试，某源失败才换下一个源，全失败才整体报错
 * - 成功结果带实际命中来源（source = adapter.name）；请求参数不参与来源选择
 * - 失败时如实汇总每源真实原因（不把源缺失说成“暂无数据”）
 * - 排序字段映射上游 fid（changePct → f3，amount → f6）：东财上游降序返回，
 *   新浪由 adapter 在边界内本地排序截断
 * - status() 记录每个源的真实尝试 / 成功 / 失败，不把未配置的源伪装成 healthy
 * - 空列表 → 正常返回 + warnings=['empty-list']
 */

interface ManagerOptions {
  readonly adapters: readonly SectorQuoteAdapterLike[];
  readonly logger: Logger;
  readonly clock: () => Date;
}

const SORT_TO_FID: Record<FetchSectorQuotesQuery['sort'], 'f3' | 'f6'> = {
  changePct: 'f3',
  amount: 'f6',
};

function mapItem(raw: SectorQuoteRawItem): SectorQuoteItem {
  return {
    code: raw.code,
    name: raw.name,
    price: raw.price,
    changePct: raw.change_pct,
    change: raw.change,
    amount: raw.amount,
    ...(raw.up_count === undefined ? {} : { upCount: raw.up_count }),
    ...(raw.down_count === undefined ? {} : { downCount: raw.down_count }),
    ...(raw.leading_stock_name === undefined ? {} : { leadingStockName: raw.leading_stock_name }),
    ...(raw.leading_stock_code === undefined ? {} : { leadingStockCode: raw.leading_stock_code }),
    ...(raw.leading_stock_change_pct === undefined
      ? {}
      : { leadingStockChangePct: raw.leading_stock_change_pct }),
  };
}

function errorResult(message: string): SectorQuoteResult {
  return {
    ok: false,
    error: {
      kind: 'adapter_error',
      adapter: 'sector-quote',
      message,
      recoverable: false,
    },
  };
}

export class SectorQuoteManager {
  readonly name = 'sector-quote' as const;
  readonly sources: readonly string[];

  private readonly adapters: readonly SectorQuoteAdapterLike[];
  private readonly logger: Logger;
  private readonly clock: () => Date;
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
    if (opts.adapters.length === 0) throw new Error('sector-quote 至少需要一个数据源');
    this.adapters = opts.adapters;
    this.sources = opts.adapters.map((adapter) => adapter.name);
    this.logger = opts.logger;
    this.clock = opts.clock;
  }

  status(): readonly SourceStatus[] {
    return this.adapters.map((adapter) => ({
      dataset: 'sector-quote',
      source: adapter.name,
      coverage: [],
      capabilityEnabled: true,
      configurationReady: true,
      ...(this.observations.get(adapter.name) ?? {}),
    }));
  }

  async fetchList(query: FetchSectorQuotesQuery): Promise<SectorQuoteResult> {
    const fid = SORT_TO_FID[query.sort];
    const pageSize = query.all === true ? undefined : query.limit;
    const failures: string[] = [];

    for (const adapter of this.adapters) {
      const observation = this.observations.get(adapter.name) ?? {};
      this.observations.set(adapter.name, observation);
      observation.lastAttemptAt = this.clock();

      let rawItems: readonly SectorQuoteRawItem[];
      try {
        ({ items: rawItems } = await adapter.fetchList(pageSize, fid));
      } catch (error) {
        observation.lastErrorKind = sourceErrorKindOf(error);
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn('sector-quote source failed', {
          source: adapter.name,
          error: message,
        });
        failures.push(`${adapter.name}: ${message}`);
        continue;
      }

      const now = this.clock();
      observation.lastSuccessAt = now;
      delete observation.lastErrorKind;
      observation.dataAsOf = now;

      const items = (query.all === true ? rawItems : rawItems.slice(0, query.limit)).map(mapItem);
      const warnings: string[] = [];
      if (items.length === 0) warnings.push('empty-list');

      return {
        ok: true,
        data: {
          total: items.length,
          source: adapter.name,
          items,
          warnings,
          asOf: now,
        },
      };
    }

    return errorResult(
      `所有板块行情源均失败（${this.sources
        .map((source) => sourceLabel(source))
        .join(' → ')}）：${failures.join('; ')}`,
    );
  }
}
