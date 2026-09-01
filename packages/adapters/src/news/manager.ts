import type { FetchNewsQuery, Logger, NewsItem, SourceStatus } from '@luoome/core';
import { inferNewsCategory } from '@luoome/core';

import type { SourceHandle, SourceRegistry } from '../source-registry.js';
import type { NewsCapabilityMap, NewsRawItem, NewsResult } from './types.js';

/**
 * NewsManager。
 *
 * 对齐 dragon-tiger / northbound-flow 的错误模型，但更简：
 * - 新闻是 7×24 滚动流，不涉及交易日历
 * - 无缓存；源循环替换为 registry handle 循环
 *   （docs/ddd/source-pluggability-and-observation-design.md §6.3）：
 *   按绑定顺序 fallback；显式 query.source 只尝试该源，未启用返回既有 adapter_error 协议
 * - 分类 / 关键词过滤在 manager 侧对单页快照执行（上游不支持），与参考产品行为一致；
 *   为避免过滤后空窗，固定拉取 FETCH_POOL_SIZE 条再过滤截断到 limit
 * - 空列表 → 正常返回 + warnings=['empty-list']
 */

interface ManagerOptions {
  readonly registry: SourceRegistry<NewsCapabilityMap>;
  readonly logger: Logger;
  readonly clock: () => Date;
}

/** 固定拉取池大小：上游单页上限 100，覆盖过滤损耗。 */
const FETCH_POOL_SIZE = 100;

function mapItem(raw: NewsRawItem): NewsItem {
  return {
    id: raw.id,
    title: raw.title,
    summary: raw.summary?.trim() ?? raw.title,
    category: inferNewsCategory(raw.title),
    source: raw.source?.trim() ?? '东方财富',
    publishedAt: new Date(raw.published_at),
    url: raw.url ?? '',
  };
}

function errorResult(message: string): NewsResult {
  return {
    ok: false,
    error: {
      kind: 'adapter_error',
      adapter: 'news',
      message,
      recoverable: false,
    },
  };
}

export class NewsManager {
  readonly name = 'news' as const;
  readonly sources: readonly string[];

  private readonly handles: readonly SourceHandle<NewsCapabilityMap, 'finance-news'>[];
  private readonly registry: SourceRegistry<NewsCapabilityMap>;
  private readonly logger: Logger;
  private readonly clock: () => Date;

  constructor(opts: ManagerOptions) {
    this.registry = opts.registry;
    this.handles = opts.registry.sources('finance-news');
    if (this.handles[0] === undefined) {
      throw new Error('news registry 缺少 finance-news capability 绑定');
    }
    this.sources = [...new Set(this.handles.map((handle) => handle.source))];
    this.logger = opts.logger;
    this.clock = opts.clock;
  }

  status(): readonly SourceStatus[] {
    return this.registry.describe();
  }

  async fetchNews(query: FetchNewsQuery): Promise<NewsResult> {
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
        const filtered = query.category !== undefined || query.keyword !== undefined;
        const rawResult = await handle.execute({
          page: query.page,
          pageSize: filtered ? FETCH_POOL_SIZE : query.limit,
        });

        let items = rawResult.items.map(mapItem);
        if (query.category !== undefined) {
          items = items.filter((item) => item.category === query.category);
        }
        const keyword = query.keyword;
        if (keyword !== undefined) {
          items = items.filter(
            (item) => item.title.includes(keyword) || item.summary.includes(keyword),
          );
        }
        items = items.slice(0, query.limit);

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
        this.logger.warn('news source failed', {
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
