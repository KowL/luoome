import type { FinancialSnapshotQuery, Logger, SourceStatus } from '@luoome/core';

import type { FuyaoFinancialSnapshotAdapter } from './fuyao.js';
import type { FinancialSnapshotManagerLike, FinancialSnapshotResultLike } from './types.js';

/**
 * 财务当前快照 Manager。
 *
 * 设计：docs/ddd/fuyao-data-expansion-and-tushare-retirement-design.md §11.1
 *
 * 关键约束：
 * - 只读查询，不写入 financial_fact_revisions；
 * - viewKind='current-vendor-view'，pitStatus='not-ready'；
 * - 不进入 strict PIT 评分；
 * - 按绑定顺序逐 adapter 拉取，全部失败抛 adapter_error。
 */

interface ManagerOptions {
  readonly adapters: readonly FuyaoFinancialSnapshotAdapter[];
  readonly logger: Logger;
  readonly clock: () => Date;
}

function errorResult(message: string): FinancialSnapshotResultLike {
  return {
    ok: false,
    error: {
      kind: 'adapter_error',
      adapter: 'financial-snapshot',
      message,
      recoverable: false,
    },
  };
}

export class FinancialSnapshotManager implements FinancialSnapshotManagerLike {
  readonly name = 'financial-snapshot' as const;
  readonly sources: readonly string[];

  private readonly adapters: readonly FuyaoFinancialSnapshotAdapter[];
  private readonly logger: Logger;

  constructor(opts: ManagerOptions) {
    this.adapters = opts.adapters;
    if (this.adapters.length === 0) {
      throw new Error('financial-snapshot manager 缺少 adapter 绑定');
    }
    this.sources = this.adapters.map(() => 'fuyao');
    this.logger = opts.logger;
  }

  status(): readonly SourceStatus[] {
    return this.adapters.flatMap((adapter) => adapter.status());
  }

  async fetchSnapshot(query: FinancialSnapshotQuery): Promise<FinancialSnapshotResultLike> {
    // 按绑定顺序逐 adapter 拉取；全部失败返回 adapter_error
    let lastError: unknown;
    for (const adapter of this.adapters) {
      try {
        const snapshot = await adapter.fetchSnapshot(query);
        return { ok: true, data: snapshot };
      } catch (err) {
        this.logger.warn('financial-snapshot source failed', {
          source: 'fuyao',
          error: err instanceof Error ? err.message : String(err),
        });
        lastError = err;
      }
    }

    return errorResult(
      `all sources failed (${this.sources.join(' → ')}): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}
