import type { ReportPublication } from '../entity/report-publication.js';

/**
 * 发布记录的持久化（REQ-M5-02）。
 *
 * ## 「同一版不能重复发布」由本接口保证
 *
 * `publish()` **不是 upsert**：已存在同 `reportId` 的发布记录时返回 `published: false`，
 * 而不是覆盖。理由：发布是**一次性动作**，允许重复会把「已发布」变成「随时可改」，
 * 而那正是这个概念要防的。
 *
 * 若要重新发布（内容已变），调用方必须先显式撤销旧记录（当前**不提供**该操作，
 * 因为「撤销发布」是另一个需求）。
 */
export interface ReportPublicationRepository {
  /**
   * 发布一个版本。**幂等但不覆盖**：
   * - 首次发布 → `{ published: true, publication }`
   * - 已发布过同一 `reportId` → `{ published: false, publication: <既有记录> }`
   */
  publish(publication: ReportPublication): Promise<{
    readonly published: boolean;
    readonly publication: ReportPublication;
  }>;

  /** 按报告 id 读发布记录；未发布返回 `null`。 */
  findByReportId(reportId: string): Promise<ReportPublication | null>;
}
