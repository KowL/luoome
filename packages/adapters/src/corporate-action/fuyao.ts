import { createHash } from 'node:crypto';

import type { CorporateActionEventRevision } from '@luoome/core';
import { corporateActionEventContent } from '@luoome/core';
import { ZodError, z } from 'zod';

import type { FuyaoClient } from '../fuyao/client.js';
import { normalizeFuyaoThscode } from '../fuyao/source.js';
import { invalidPayloadError, SourceExecutionError } from '../source-error.js';
import type { CorporateActionFetchResult, CorporateActionQuery } from './types.js';

/**
 * Fuyao 公司行动在线 adapter（`GET /api/a-share/corporate-actions/adjustment-factors`）。
 *
 * 契约（Phase 0 证据：fuyao-phase0-contract-verification-2026-11-03.md §3、
 * fuyao-phase0-dump-evidence.md §4）：
 * - 响应 `data = { thscode, ticker, item[] }`；item 稳定为
 *   `ticker / ex_date_ms / dividend_per_share / per_share_bonus` 四键——
 *   在线端点不返回 event_type / record_date / adjust_factor / allotment_*；
 * - `ex_date_ms` 为上海零点毫秒；item 按 ex_date_ms 降序；
 * - `from/to`（YYYY-MM-DD）按除权日过滤；无事件窗口返回 `code=3002`（no_data），
 *   不是空 item 列表——本 adapter 把 3002 当合法空窗口，返回空 events；
 * - 配股除权日在线呈现为「零分红零送股」行（600030.SH 实测），与「无事件」
 *   无法区分——零值行必须原样保留，不得当噪声丢弃；
 * - allotmentRatio/allotmentPrice 恒 null、dumpId/artifactSha256 恒 null：
 *   不发明配股字段，不声称在线配股覆盖；配股证据只能来自 adjustment-factors dump；
 * - sourceRecordId 由 thscode + exDate + 规范化事件内容稳定派生，不冒充上游
 *   revision 或公告 ID；纯重复行按内容去重，同日不同内容分别保留。
 */

/** 在线 item 四键（Phase 0 实测稳定集合）；额外键不视为漂移，配股字段不从此解析。 */
const CorporateActionItemSchema = z.object({
  ticker: z.string().min(1),
  ex_date_ms: z.number(),
  dividend_per_share: z.number().nonnegative(),
  per_share_bonus: z.number().gt(-1),
});

const CorporateActionDataSchema = z.object({
  thscode: z.string().min(1),
  ticker: z.string().nullish(),
  item: z.array(CorporateActionItemSchema),
});

/** ex_date_ms（上海零点毫秒）→ 该除权日 UTC 00:00（与 DailyBar.date / RawDailyBar 同约定）。 */
const msToExDate = (ms: number): Date => {
  const shifted = new Date(ms + 8 * 3_600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
};

/** Date → 上海日历日 YYYY-MM-DD（from/to 查询参数口径）。 */
const toShanghaiDateParam = (date: Date): string => {
  const shifted = new Date(date.getTime() + 8 * 3_600_000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** 规范化事件内容 → 全量内容 hash（SHA-256 64 位十六进制，审计 / 幂等识别）。 */
const contentHashOf = (event: Parameters<typeof corporateActionEventContent>[0]): string =>
  createHash('sha256').update(corporateActionEventContent(event)).digest('hex');

export class FuyaoCorporateActionAdapter {
  readonly name = 'fuyao';

  private readonly clock: () => Date;

  constructor(
    private readonly client: FuyaoClient,
    options: { readonly clock?: () => Date } = {},
  ) {
    this.clock = options.clock ?? ((): Date => new Date());
  }

  /**
   * 在线补取单股公司行动事件。3002（无事件窗口）返回空 events；
   * 其余信封错误按 kind 原样抛出（permission / rate_limited / upstream_error）。
   */
  async fetchEvents(query: CorporateActionQuery): Promise<CorporateActionFetchResult> {
    const thscode = normalizeFuyaoThscode(query.stockId);
    let data: unknown;
    try {
      const result = await this.client.getData(
        '/api/a-share/corporate-actions/adjustment-factors',
        {
          thscode,
          ...(query.from === undefined ? {} : { from: toShanghaiDateParam(query.from) }),
          ...(query.to === undefined ? {} : { to: toShanghaiDateParam(query.to) }),
        },
      );
      data = result.data;
    } catch (error) {
      // 3001/3002 → no_data：合法空窗口（无事件），不是失败。
      if (error instanceof SourceExecutionError && error.kind === 'no_data') {
        return { stockId: thscode, events: [] };
      }
      throw error;
    }

    let parsed: z.infer<typeof CorporateActionDataSchema>;
    try {
      parsed = CorporateActionDataSchema.parse(data);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidPayloadError(
          `fuyao corporate-action: data 形状不符（${error.message}）`,
          error,
        );
      }
      throw error;
    }

    const recordedAt = this.clock();
    const seen = new Set<string>();
    const events: CorporateActionEventRevision[] = [];
    for (const item of parsed.item) {
      const exDate = msToExDate(item.ex_date_ms);
      const contentInput = {
        stockId: thscode,
        exDate,
        dividendPerShare: item.dividend_per_share,
        perShareBonus: item.per_share_bonus,
        allotmentRatio: null,
        allotmentPrice: null,
        currency: 'CNY' as const,
        source: 'fuyao' as const,
      };
      const contentHash = contentHashOf(contentInput);
      // 纯重复行按内容去重；同日不同内容（不同 hash）分别保留。
      if (seen.has(contentHash)) continue;
      seen.add(contentHash);
      events.push({
        ...contentInput,
        sourceRecordId: `fuyao:${thscode}:${exDate.getTime()}:${contentHash}`,
        dumpId: null,
        artifactSha256: null,
        recordedAt,
        contentHash,
      });
    }
    events.sort((left, right) => left.exDate.getTime() - right.exDate.getTime());
    return { stockId: thscode, events };
  }
}
