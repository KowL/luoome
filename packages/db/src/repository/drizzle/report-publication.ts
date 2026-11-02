import type { ReportPublication, ReportPublicationRepository } from '@luoome/core';
import { eq } from 'drizzle-orm';

import type { DrizzleDatabase } from '../../database.js';
import type { Schema } from '../../schema/index.js';
import { reportPublications as table } from '../../schema/report-publication.js';

/** `report_publications` 的 drizzle 实现（REQ-M5-02）。 */
export class DrizzleReportPublicationRepository implements ReportPublicationRepository {
  constructor(private readonly db: DrizzleDatabase<Schema>) {}

  async publish(publication: ReportPublication): Promise<{
    readonly published: boolean;
    readonly publication: ReportPublication;
  }> {
    const existing = await this.findByReportId(publication.reportId);
    // **幂等但不覆盖**：主键已存在时原样返回旧记录，不做 upsert。
    if (existing !== null) return { published: false, publication: existing };
    this.db
      .insert(table)
      .values({
        reportId: publication.reportId,
        version: publication.version,
        publishedAt: publication.publishedAt,
        documentHash: publication.documentHash,
        frozenAt: publication.frozenAt,
      })
      .run();
    return { published: true, publication };
  }

  async findByReportId(reportId: string): Promise<ReportPublication | null> {
    const row = this.db.select().from(table).where(eq(table.reportId, reportId)).get();
    if (row === undefined) return null;
    return {
      reportId: row.reportId,
      version: row.version,
      publishedAt: row.publishedAt,
      documentHash: row.documentHash,
      frozenAt: row.frozenAt,
    };
  }
}
