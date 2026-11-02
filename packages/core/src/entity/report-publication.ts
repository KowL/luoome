import { z } from 'zod';

/**
 * 报告的**发布记录**（REQ-M5-02）。
 *
 * ## 为什么必须新建这个概念
 *
 * 「只导出已发布/已冻结的内容」这条验收，前提是系统里**存在**「已发布」这个状态。
 * 查证结果：`ReportStatusSchema` 只有 `complete` / `partial`（**内容完整度**），
 * `deliveryStatus` 表示投递，`upsertForPeriod` 会**覆盖**同一期版本 ——
 * **没有任何东西能回答「这一版被正式发布过吗」。**
 *
 * 若用「仓储里存在这条记录」当判据，等于没验：任何报告只要存过就算发布。
 * **那是形式主义验收**（本会话反复出现的形态）。
 *
 * ## `documentHash` 是**时间点快照**，不是跟随状态
 *
 * 记录的是「发布那一刻渲染出来的那份文档」的哈希。
 * 之后报告被 `upsertForPeriod` 覆盖，**发布记录仍指向旧哈希** ——
 * 于是「内容变了但发布记录没更新」这件事**可被发现**，而不是静默跟随。
 */
export const ReportPublicationSchema = z
  .object({
    /** 被发布的报告 id（`Report.id`）。 */
    reportId: z.string().min(1),
    /** 发布时的报告版本（与 `Report.version` 对齐，缺省视为 1）。 */
    version: z.number().int().positive(),
    /** 发布动作发生的时刻。 */
    publishedAt: z.coerce.date(),
    /**
     * **发布那一刻**渲染出的文档哈希。
     * 之后报告被覆盖不会改变它 —— 这正是「快照」的含义。
     */
    documentHash: z.string().length(64),
    /**
     * 冻结时刻：此后该版本的内容**不允许再被导出替换**。
     * 与 `publishedAt` 分开是因为「发布」与「冻结」在流程上可能分两步
     * （先发布供投递，再冻结供归档）。当前实现里两者同时写入。
     */
    frozenAt: z.coerce.date(),
  })
  .strict();
export type ReportPublication = z.infer<typeof ReportPublicationSchema>;

/**
 * 发布记录与当前报告的**一致性判定**。
 *
 * 导出前必须跑这一关：**发布记录里的哈希 ≠ 当前报告渲染出的哈希** ⇒ 内容已变，
 * 该发布记录不再代表当前内容，**拒绝导出并说明**。
 */
export const publicationMatchesCurrent = (input: {
  readonly publication: Pick<ReportPublication, 'reportId' | 'documentHash'>;
  readonly currentReportId: string;
  readonly currentDocumentHash: string;
}): boolean =>
  input.publication.reportId === input.currentReportId &&
  input.publication.documentHash === input.currentDocumentHash;

/** 可导出的拒绝原因。 */
export const PUBLISH_REJECTIONS = [
  /** 该报告从未发布过。 */
  'not-published',
  /** 发布过，但之后内容变了（哈希不一致）。 */
  'published-content-changed',
] as const;
export const PublishRejectionSchema = z.enum(PUBLISH_REJECTIONS);
export type PublishRejection = z.infer<typeof PublishRejectionSchema>;
