import { z } from 'zod';

/**
 * 数据商快照（REQ-M4-05 **层 3：告警层**）。
 *
 * ## 为什么它必须与 `financial_fact_revisions` 分开
 *
 * 层 3 的职责是「**发现上游漂移并告警**」，不是「记录修订」。
 * 若它写进 `financial_fact_revisions`，那么东财改一次口径（值没变、`UPDATE_DATE` 变了）
 * 就会被当成一次真实修订 —— **PIT 立刻失效**：
 * `resolveVintage` 会开始返回「数据商今天说什么就是什么」的 vintage。
 *
 * spike 报告实测过这个反例：
 * - 2016A 值未变但 `UPDATE_DATE` 变 → **假阳性**
 * - 2017A 停在 v2，缺 v3 → **漏报**
 * - 2018A 采纳了 v2 但 `UPDATE_DATE` 漂移 4 个月
 *
 * ⇒ 所以这张表**只是观测记录**，`resolveVintage` **永不读它**（有守卫钉住）。
 */
export const FinancialIngestSnapshotSchema = z
  .object({
    id: z.string().min(1),
    stockId: z.string().min(1),
    metricId: z.string().min(1),
    periodEnd: z.coerce.date(),
    /** `sha256(规范化 payload)` —— **只用于判「原始 payload 变了没」**。 */
    ingestHash: z.string().length(64),
    /** 数据商自报的更新时间；**只做展示，不参与任何 PIT 判断**。 */
    vendorUpdatedAt: z.coerce.date().nullable(),
    /** 抓取时刻（真实，不回填）。 */
    capturedAt: z.coerce.date(),
  })
  .strict();
export type FinancialIngestSnapshot = z.infer<typeof FinancialIngestSnapshotSchema>;

/**
 * 层 3 的一次检测结果。
 *
 * `vendor-drift`：payload 变了，但**公告集合没有新增** ⇒ 是数据商改口径，不是真实修订。
 * `revision-observed`：公告集合新增了 ⇒ 层 1 会处理，层 3 只记录「也看到了」。
 * `unchanged`：哈希没变。
 */
export const FinancialIngestVerdictSchema = z.enum([
  'unchanged',
  'vendor-drift',
  'revision-observed',
]);
export type FinancialIngestVerdict = z.infer<typeof FinancialIngestVerdictSchema>;
