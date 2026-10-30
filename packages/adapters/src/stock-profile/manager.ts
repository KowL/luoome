import type { Logger, SourceStatus, StockProfileQuery } from '@luoome/core';

import { sourceErrorKindOf } from '../source-error.js';
import type { SourceHandle, SourceRegistry } from '../source-registry.js';
import type { StockProfileCapabilityMap, StockProfileResult } from './types.js';

/**
 * StockProfileManager。
 *
 * 与 dragon-tiger / northbound-flow manager 同构，但去掉交易日历语义：
 * - 无缓存：个股档案是低频只读快照
 * - 源循环为 registry handle 循环（docs/ddd/source-pluggability-and-observation-design.md §6.3）：
 *   按绑定顺序 fallback；显式 query.source 只尝试该源，未启用返回既有 adapter_error 协议
 * - 上游无数据（空股东户数 / 空板块）是合法结果，返回空数组而不是报错
 */

interface ManagerOptions {
  readonly registry: SourceRegistry<StockProfileCapabilityMap>;
  readonly logger: Logger;
  readonly clock: () => Date;
}

function errorResult(message: string, recoverable = false): StockProfileResult {
  return {
    ok: false,
    error: {
      kind: 'adapter_error',
      adapter: 'stock-profile',
      message,
      recoverable,
    },
  };
}

export class StockProfileManager {
  readonly name = 'stock-profile' as const;
  readonly sources: readonly string[];

  private readonly handles: readonly SourceHandle<StockProfileCapabilityMap, 'stock-profile'>[];
  private readonly registry: SourceRegistry<StockProfileCapabilityMap>;
  private readonly logger: Logger;
  private readonly clock: () => Date;

  constructor(opts: ManagerOptions) {
    this.registry = opts.registry;
    this.handles = opts.registry.sources('stock-profile');
    if (this.handles[0] === undefined) {
      throw new Error('stock-profile registry 缺少 stock-profile capability 绑定');
    }
    this.sources = [...new Set(this.handles.map((handle) => handle.source))];
    this.logger = opts.logger;
    this.clock = opts.clock;
  }

  status(): readonly SourceStatus[] {
    return this.registry.describe();
  }

  async fetchProfile(query: StockProfileQuery): Promise<StockProfileResult> {
    const now = this.clock();
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
        const result = await handle.execute({ stockId: query.stockId });
        return {
          ok: true,
          data: {
            stockId: query.stockId,
            source: handle.source,
            asOf: now.toISOString(),
            holders: [...result.holders],
            concepts: [...result.concepts],
          },
        };
      } catch (err) {
        this.logger.warn('stock-profile source failed', {
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
      ['network', 'timeout', 'rate_limited', 'upstream_error'].includes(
        sourceErrorKindOf(lastError),
      ),
    );
  }
}
