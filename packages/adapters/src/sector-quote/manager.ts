import type { FetchSectorQuotesQuery, Logger, SectorQuoteItem, SourceStatus } from '@luoome/core';

import type { SourceHandle, SourceRegistry } from '../source-registry.js';
import type { SectorQuoteCapabilityMap, SectorQuoteRawItem, SectorQuoteResult } from './types.js';

/**
 * SectorQuoteManager（fuyao-data-expansion §10.1：从单 primary 迁到独立 SourceRegistry）。
 *
 * 对齐 news 的最简错误模型：
 * - 板块行情是实时快照，不涉及交易日历
 * - 无缓存；源循环替换为 registry handle 循环：按绑定顺序 fallback；
 *   显式 query.source 只尝试该源，未启用返回既有 adapter_error 协议
 * - 排序字段映射上游 fid（changePct → f3，amount → f6），上游降序返回，manager 不再排序
 * - 输出的 source 取实际成功 handle，不回显请求默认值
 * - 空列表 → 正常返回 + warnings=['empty-list']
 */

interface ManagerOptions {
  readonly registry: SourceRegistry<SectorQuoteCapabilityMap>;
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

  private readonly handles: readonly SourceHandle<SectorQuoteCapabilityMap, 'sector-quote'>[];
  private readonly registry: SourceRegistry<SectorQuoteCapabilityMap>;
  private readonly logger: Logger;
  private readonly clock: () => Date;

  constructor(opts: ManagerOptions) {
    this.registry = opts.registry;
    this.handles = opts.registry.sources('sector-quote');
    if (this.handles[0] === undefined) {
      throw new Error('sector-quote registry 缺少 sector-quote capability 绑定');
    }
    this.sources = [...new Set(this.handles.map((handle) => handle.source))];
    this.logger = opts.logger;
    this.clock = opts.clock;
  }

  status(): readonly SourceStatus[] {
    return this.registry.describe();
  }

  async fetchList(query: FetchSectorQuotesQuery): Promise<SectorQuoteResult> {
    const now = this.clock();

    // 显式 source 路由约束：只尝试该源；未启用返回既有 adapter_error 协议（§4.6）
    const handles =
      query.source === undefined
        ? this.handles
        : this.handles.filter((handle) => handle.source === query.source);
    if (handles.length === 0) {
      return errorResult(`source ${String(query.source)} 未启用`);
    }

    let lastError: unknown;
    for (const handle of handles) {
      try {
        const rawResult = await handle.execute({
          pageSize: query.all === true ? undefined : query.limit,
          fid: SORT_TO_FID[query.sort],
        });

        const items = (
          query.all === true ? rawResult.items : rawResult.items.slice(0, query.limit)
        ).map(mapItem);

        const warnings: string[] = [];
        if (items.length === 0) warnings.push('empty-list');

        return {
          ok: true,
          data: {
            total: items.length,
            source: handle.source,
            items,
            warnings,
            asOf: now,
          },
        };
      } catch (err) {
        this.logger.warn('sector-quote source failed', {
          source: handle.source,
          error: err instanceof Error ? err.message : String(err),
        });
        lastError = err;
      }
    }

    return errorResult(
      `all sources failed (${handles.map((handle) => handle.source).join(' → ')}): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}
