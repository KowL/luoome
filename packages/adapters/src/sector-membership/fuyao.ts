import { createHash } from 'node:crypto';

import type { SectorMembershipType } from '@luoome/core';
import { ZodError, z } from 'zod';

import type { FuyaoClient } from '../fuyao/client.js';
import { invalidPayloadError } from '../source-error.js';
import type {
  SectorCatalogFetchResult,
  SectorMembershipFetchResult,
  SectorMembershipRawEntry,
  SectorMembershipRawGroup,
} from './types.js';

/**
 * Fuyao 个股板块反查 adapter（`GET /api/a-share-index/constituents/ths-index-list-by-stock`）。
 *
 * 契约（Phase 0 实测，docs/ddd/fuyao-phase0-special-evidence.md §5.3）：
 * - `data` 形状 `{ item[{ thscode, index_list[{ thscode, name, type }] }] }`；
 *   按输入顺序每组保留，无匹配返回空 `index_list`（空列表 ≠ 股票不存在）
 * - 省略 `type` 返回全部四类（cn_concept / industry / region / tszs）
 * - 单次最多 100 个代码（101 → code=1003）；非法代码 → 1002 且整批 data=null
 * - 无分页、无 `timestamp` 字段——关系快照的 fetchedAt 只能用本地获取时间
 * - 北交所代码接口接受但当前无关系数据，返回空组不报错
 *
 * 身份与名称：
 * - 板块身份保留上游 `.TI` 标准代码，不伪造 Eastmoney `BKxxxx`
 * - `name` 缺失（null/空串）时保持缺失，由 manager 从板块目录 join；不用代码回填
 * - contentHash 由规范化分组内容稳定派生（SHA-256 前 16 位十六进制），
 *   只用于审计与幂等识别，不冒充上游 revision
 */

const MembershipEntrySchema = z.object({
  thscode: z.string().min(1),
  name: z.string().nullish(),
  type: z.enum(['industry', 'cn_concept', 'region', 'tszs']),
});

const MembershipGroupSchema = z.object({
  thscode: z.string().min(1),
  index_list: z.array(MembershipEntrySchema),
});

const MembershipDataSchema = z.object({
  item: z.array(MembershipGroupSchema),
});

const CatalogItemSchema = z.object({
  thscode: z.string().min(1),
  name: z.string().min(1),
});

const CatalogDataSchema = z.object({
  timestamp: z.number().nullish(),
  item: z.array(CatalogItemSchema),
});

const CATALOG_TAGS = ['industry', 'cn_concept', 'region', 'tszs'] as const;

/** 规范化内容 → 稳定 hash：只依赖分组/归属内容，与请求顺序无关的字段不参与。 */
export const sectorMembershipContentHash = (
  groups: readonly SectorMembershipRawGroup[],
): string => {
  const normalized = groups.map((group) => ({
    stockId: group.stockId,
    memberships: group.memberships.map((entry) => ({
      sectorCode: entry.sectorCode,
      ...(entry.sectorName === undefined ? {} : { sectorName: entry.sectorName }),
      type: entry.type,
    })),
  }));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
};

export class FuyaoSectorMembershipAdapter {
  readonly name = 'fuyao';

  constructor(private readonly client: FuyaoClient) {}

  async fetchMemberships(
    stockIds: readonly string[],
    type?: SectorMembershipType,
  ): Promise<SectorMembershipFetchResult> {
    const { data } = await this.client.getData(
      '/api/a-share-index/constituents/ths-index-list-by-stock',
      {
        thscodes: stockIds.join(','),
        ...(type === undefined ? {} : { type }),
      },
    );
    let parsed: z.infer<typeof MembershipDataSchema>;
    try {
      parsed = MembershipDataSchema.parse(data);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidPayloadError(
          `fuyao sector-membership: data 形状不符（${error.message}）`,
          error,
        );
      }
      throw error;
    }

    const byStock = new Map<string, SectorMembershipRawEntry[]>();
    for (const group of parsed.item) {
      const entries: SectorMembershipRawEntry[] = group.index_list.map((entry) => {
        const name = entry.name?.trim();
        return {
          sectorCode: entry.thscode,
          ...(name === undefined || name.length === 0 ? {} : { sectorName: name }),
          type: entry.type,
        };
      });
      byStock.set(group.thscode, entries);
    }
    // 按请求顺序对齐输出；上游缺失的组按空关系处理（空列表 ≠ 股票不存在）。
    const groups: SectorMembershipRawGroup[] = stockIds.map((stockId) => ({
      stockId,
      memberships: byStock.get(stockId) ?? [],
    }));
    return { groups, contentHash: sectorMembershipContentHash(groups) };
  }

  /**
   * 板块目录（四类 tag 全量合并，`.TI` → 名称）；单 tag 一次性全量返回、无分页。
   * 同一代码出现在多个 tag 时以先返回的为准（实测四类代码空间不重叠）。
   */
  async fetchCatalog(): Promise<SectorCatalogFetchResult> {
    const items: { sectorCode: string; sectorName: string }[] = [];
    const seen = new Set<string>();
    for (const tag of CATALOG_TAGS) {
      const { data } = await this.client.getData('/api/a-share-index/catalog/ths-index-list', {
        tag,
      });
      let parsed: z.infer<typeof CatalogDataSchema>;
      try {
        parsed = CatalogDataSchema.parse(data);
      } catch (error) {
        if (error instanceof ZodError) {
          throw invalidPayloadError(
            `fuyao sector-catalog: data 形状不符（tag=${tag}，${error.message}）`,
            error,
          );
        }
        throw error;
      }
      for (const entry of parsed.item) {
        if (seen.has(entry.thscode)) continue;
        seen.add(entry.thscode);
        items.push({ sectorCode: entry.thscode, sectorName: entry.name });
      }
    }
    return { items };
  }
}
