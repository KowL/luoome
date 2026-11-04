import { ZodError, z } from 'zod';

import type { FuyaoClient } from '../fuyao/client.js';
import { invalidPayloadError } from '../source-error.js';
import type { SectorQuoteAdapterLike, SectorQuoteRawItem } from './types.js';

/**
 * Fuyao 板块行情 adapter（`catalog/ths-index-list` + `prices/snapshot`）。
 *
 * 契约（Phase 0 实测，docs/ddd/fuyao-phase0-special-evidence.md §5.1/§5.2）：
 * - 目录 `GET /api/a-share-index/catalog/ths-index-list?tag=industry` 单 tag 一次性全量返回，
 *   无分页；`data.item[]` 为 `{ thscode, name }`，指数代码全部 `.TI` 后缀
 * - 快照 `GET /api/a-share-index/prices/snapshot` 必须传 `thscodes`（缺参 1001）；
 *   `limit/offset` 无效；`data.item[]` **没有 name 字段**——名称必须从目录 join
 * - 快照 `ticker` 是上游原始代码（如 `1A0001`），不是纯数字代码，不用于身份
 * - `price_change_ratio_pct` 是百分数原值（`-0.822698` 表示 -0.82%），映射小数口径需 /100
 * - `data.timestamp` 是采样时刻（retrieval 语义），不生成盘中 observedAt
 * - `upCount/downCount/leadingStock*` 上游不返回，保持缺省，不用 0 或现价合成
 *
 * 排序：上游快照不支持 fid 排序，adapter 拉全量后在本地按 fid 降序排序
 * （f3 涨跌幅 / f6 成交额），与 Eastmoney 上游降序返回的输出契约一致。
 */

const CATALOG_TAG = 'industry';
/** 快照请求的有界批次大小（上游未声明上限；与个股反查 100 只有界口径对齐）。 */
const SNAPSHOT_BATCH_SIZE = 100;

const CatalogItemSchema = z.object({
  thscode: z.string().min(1),
  name: z.string().min(1),
});

const CatalogDataSchema = z.object({
  timestamp: z.number().nullish(),
  item: z.array(CatalogItemSchema),
});

const SnapshotItemSchema = z.object({
  thscode: z.string().min(1),
  last_price: z.number().nullish(),
  price_change: z.number().nullish(),
  price_change_ratio_pct: z.number().nullish(),
  turnover: z.number().nullish(),
});

const SnapshotDataSchema = z.object({
  timestamp: z.number().nullish(),
  total: z.number().int().nonnegative().nullish(),
  item: z.array(SnapshotItemSchema),
});

const parseWith = <T>(schema: z.ZodType<T>, data: unknown, what: string): T => {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof ZodError) {
      throw invalidPayloadError(`fuyao sector-quote: ${what} 形状不符（${error.message}）`, error);
    }
    throw error;
  }
};

export class FuyaoSectorQuoteAdapter implements SectorQuoteAdapterLike {
  readonly name = 'fuyao';

  constructor(private readonly client: FuyaoClient) {}

  async fetchList(
    pageSize: number | undefined,
    fid: 'f3' | 'f6',
  ): Promise<{ readonly items: SectorQuoteRawItem[] }> {
    const catalog = await this.fetchCatalog();
    if (catalog.length === 0) return { items: [] };

    const quotes = new Map<string, z.infer<typeof SnapshotItemSchema>>();
    for (let offset = 0; offset < catalog.length; offset += SNAPSHOT_BATCH_SIZE) {
      const batch = catalog.slice(offset, offset + SNAPSHOT_BATCH_SIZE);
      const { data } = await this.client.getData('/api/a-share-index/prices/snapshot', {
        thscodes: batch.map((entry) => entry.thscode).join(','),
      });
      const parsed = parseWith(SnapshotDataSchema, data, '板块快照 data');
      for (const row of parsed.item) {
        quotes.set(row.thscode, row);
      }
    }

    const items: SectorQuoteRawItem[] = [];
    for (const entry of catalog) {
      const row = quotes.get(entry.thscode);
      if (row === undefined) continue;
      if (row.last_price == null || row.last_price <= 0) continue;
      if (row.price_change_ratio_pct == null) continue;
      items.push({
        code: entry.thscode,
        name: entry.name,
        price: row.last_price,
        change_pct: row.price_change_ratio_pct / 100,
        change: row.price_change ?? 0,
        amount: row.turnover ?? 0,
      });
      // 目录有名称而快照缺失的指数按无数据跳过，不用代码回填名称。
    }

    // 上游快照不支持排序；本地按 fid 降序，与 Eastmoney 输出契约一致。
    items.sort((a, b) => (fid === 'f3' ? b.change_pct - a.change_pct : b.amount - a.amount));
    return { items: pageSize === undefined ? items : items.slice(0, pageSize) };
  }

  private async fetchCatalog(): Promise<readonly z.infer<typeof CatalogItemSchema>[]> {
    const { data } = await this.client.getData('/api/a-share-index/catalog/ths-index-list', {
      tag: CATALOG_TAG,
    });
    const parsed = parseWith(CatalogDataSchema, data, '板块目录 data');
    return parsed.item;
  }
}
