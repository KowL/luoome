import { createHash } from 'node:crypto';

import type {
  GetStockSectorMembershipsQuery,
  Logger,
  SectorMembershipEntry,
  SourceStatus,
} from '@luoome/core';

import type { SourceHandle, SourceRegistry } from '../source-registry.js';
import type { SectorMembershipCapabilityMap, SectorMembershipResult } from './types.js';

/**
 * SectorMembershipManager（fuyao-data-expansion §10.2）。
 *
 * 对齐 news / sector-quote 的最简错误模型：
 * - 当前关系快照，不涉及交易日历；无缓存；按绑定顺序 fallback；
 *   显式 query.source 只尝试该源，未启用返回既有 adapter_error 协议
 * - 空关系组只表示当前无匹配，不证明股票不存在；全部为空 → warnings=['empty-list']
 * - 名称补全：adapter 返回缺 sectorName 的归属时，从板块目录 capability 按
 *   `.TI` 代码 join；目录也缺失时保持缺失并记 sector-name-unavailable 警告，
 *   不用代码回填名称
 * - 快照带 fetchedAt（本地获取时间；上游不返回数据时间）与 contentHash
 *   （目录 join 后的规范化内容 hash，审计 / 幂等识别，不冒充上游 revision）
 */

interface ManagerOptions {
  readonly registry: SourceRegistry<SectorMembershipCapabilityMap>;
  readonly logger: Logger;
  readonly clock: () => Date;
}

function errorResult(message: string): SectorMembershipResult {
  return {
    ok: false,
    error: {
      kind: 'adapter_error',
      adapter: 'sector-membership',
      message,
      recoverable: false,
    },
  };
}

export class SectorMembershipManager {
  readonly name = 'sector-membership' as const;
  readonly sources: readonly string[];

  private readonly handles: readonly SourceHandle<
    SectorMembershipCapabilityMap,
    'sector-membership'
  >[];
  private readonly catalogHandles: readonly SourceHandle<
    SectorMembershipCapabilityMap,
    'sector-catalog'
  >[];
  private readonly registry: SourceRegistry<SectorMembershipCapabilityMap>;
  private readonly logger: Logger;
  private readonly clock: () => Date;

  constructor(opts: ManagerOptions) {
    this.registry = opts.registry;
    this.handles = opts.registry.sources('sector-membership');
    if (this.handles[0] === undefined) {
      throw new Error('sector-membership registry 缺少 sector-membership capability 绑定');
    }
    this.catalogHandles = opts.registry.sources('sector-catalog');
    this.sources = [...new Set(this.handles.map((handle) => handle.source))];
    this.logger = opts.logger;
    this.clock = opts.clock;
  }

  status(): readonly SourceStatus[] {
    return this.registry.describe();
  }

  async fetchMemberships(query: GetStockSectorMembershipsQuery): Promise<SectorMembershipResult> {
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
        const result = await handle.execute({
          stockIds: query.stockIds,
          ...(query.type === undefined ? {} : { type: query.type }),
        });

        const warnings: string[] = [];
        const catalog = await this.fetchCatalogNames(handle.source, warnings);
        const items = result.groups.map((group) => ({
          stockId: group.stockId,
          memberships: group.memberships.map(
            (entry): SectorMembershipEntry => ({
              sectorCode: entry.sectorCode,
              ...(entry.sectorName !== undefined
                ? { sectorName: entry.sectorName }
                : catalog.get(entry.sectorCode) !== undefined
                  ? { sectorName: catalog.get(entry.sectorCode) as string }
                  : {}),
              type: entry.type,
            }),
          ),
        }));

        if (items.every((item) => item.memberships.length === 0)) {
          warnings.push('empty-list');
        }

        return {
          ok: true,
          data: {
            total: items.length,
            source: handle.source,
            items,
            warnings,
            fetchedAt: this.clock(),
            contentHash: snapshotContentHash(items),
          },
        };
      } catch (err) {
        this.logger.warn('sector-membership source failed', {
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

  /**
   * 从板块目录 capability 取 `.TI` → 名称映射；目录未绑定或失败时降级为空映射
   * （名称缺失不是致命错误，归属关系本身仍可用）。
   */
  private async fetchCatalogNames(
    source: string,
    warnings: string[],
  ): Promise<ReadonlyMap<string, string>> {
    const handle = this.catalogHandles.find((candidate) => candidate.source === source);
    if (handle === undefined) return new Map();
    try {
      const result = await handle.execute({});
      return new Map(result.items.map((item) => [item.sectorCode, item.sectorName]));
    } catch (err) {
      this.logger.warn('sector-membership catalog join failed', {
        source,
        error: err instanceof Error ? err.message : String(err),
      });
      warnings.push('sector-name-unavailable');
      return new Map();
    }
  }
}

/** 目录 join 后的规范化内容 → 稳定 hash（SHA-256 前 16 位十六进制）。 */
const snapshotContentHash = (
  items: readonly {
    readonly stockId: string;
    readonly memberships: readonly SectorMembershipEntry[];
  }[],
): string => {
  const normalized = items.map((item) => ({
    stockId: item.stockId,
    memberships: item.memberships.map((entry) => ({
      sectorCode: entry.sectorCode,
      ...(entry.sectorName === undefined ? {} : { sectorName: entry.sectorName }),
      type: entry.type,
    })),
  }));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
};
