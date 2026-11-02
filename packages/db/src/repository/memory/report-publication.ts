import type { ReportPublication, ReportPublicationRepository } from '@luoome/core';

/** `report_publications` 的 memory 实现（REQ-M5-02）。 */
export class InMemoryReportPublicationRepository implements ReportPublicationRepository {
  private readonly items = new Map<string, ReportPublication>();

  async publish(publication: ReportPublication): Promise<{
    readonly published: boolean;
    readonly publication: ReportPublication;
  }> {
    const existing = this.items.get(publication.reportId);
    // **幂等但不覆盖**：已发布过的 reportId 原样返回旧记录。
    if (existing !== undefined) return { published: false, publication: existing };
    this.items.set(publication.reportId, publication);
    return { published: true, publication };
  }

  async findByReportId(reportId: string): Promise<ReportPublication | null> {
    return this.items.get(reportId) ?? null;
  }
}
