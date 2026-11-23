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
 * 对齐 news 的最简错误模型：
 * - 板块行情是实时快照，不涉及交易日历
 * - 无缓存、当前只注册 eastmoney 一个免费源；未知来源在 factory 启动期失败
 * - 失败时如实返回该源真实原因（不把源缺失说成“暂无数据”）；注册第二源时由 factory 注入
 *   有序 adapter 列表或多源 collector，不在本层硬编码回退顺序
 * - 排序字段映射上游 fid（changePct → f3，amount → f6），上游降序返回，manager 不再排序
 * - 空列表 → 正常返回 + warnings=['empty-list']
 */

interface ManagerOptions {
  readonly primary: SectorQuoteAdapterLike;
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

  private readonly primary: SectorQuoteAdapterLike;
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private readonly observation: {
    lastAttemptAt?: Date;
    lastSuccessAt?: Date;
    dataAsOf?: Date;
    lastErrorKind?: SourceErrorKind;
  } = {};

  constructor(opts: ManagerOptions) {
    this.primary = opts.primary;
    this.sources = [opts.primary.name];
    this.logger = opts.logger;
    this.clock = opts.clock;
  }

  status(): readonly SourceStatus[] {
    return [
      {
        dataset: 'sector-quote',
        source: this.primary.name,
        coverage: [],
        capabilityEnabled: true,
        configurationReady: true,
        ...this.observation,
      },
    ];
  }

  async fetchList(query: FetchSectorQuotesQuery): Promise<SectorQuoteResult> {
    const now = this.clock();

    let rawResult: { items: SectorQuoteRawItem[] };
    this.observation.lastAttemptAt = now;
    try {
      rawResult = await this.primary.fetchList(
        query.all === true ? undefined : query.limit,
        SORT_TO_FID[query.sort],
      );
    } catch (err) {
      this.observation.lastErrorKind = sourceErrorKindOf(err);
      this.logger.warn('sector-quote primary adapter failed', {
        adapter: this.primary.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResult(
        `板块行情源 ${sourceLabel(this.primary.name)} 拉取失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.observation.lastSuccessAt = this.clock();
    delete this.observation.lastErrorKind;
    this.observation.dataAsOf = now;

    const items = (
      query.all === true ? rawResult.items : rawResult.items.slice(0, query.limit)
    ).map(mapItem);

    const warnings: string[] = [];
    if (items.length === 0) warnings.push('empty-list');

    return {
      ok: true,
      data: {
        total: items.length,
        source: query.source,
        items,
        warnings,
        asOf: now,
      },
    };
  }
}
