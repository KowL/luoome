import {
  assertResearchHypothesisVersionInvariants,
  InvariantError,
  type ResearchHypothesisVersion,
  type ResearchHypothesisVersionRepository,
} from '@luoome/core';
import { and, desc, eq, type SQL } from 'drizzle-orm';

import type { DrizzleDb } from '../../client.js';
import { researchHypothesisVersions } from '../../schema/index.js';

type HypothesisRow = typeof researchHypothesisVersions.$inferSelect;

const fromRow = (row: HypothesisRow): ResearchHypothesisVersion => ({
  id: row.id,
  topicId: row.topicId,
  documentId: row.documentId,
  documentContentHash: row.documentContentHash,
  version: row.version,
  status: row.status as ResearchHypothesisVersion['status'],
  ...(row.supersedesId === null ? {} : { supersedesId: row.supersedesId }),
  ...(row.summary === null ? {} : { summary: row.summary }),
  createdAt: row.createdAt,
});

const toRow = (
  version: ResearchHypothesisVersion,
): typeof researchHypothesisVersions.$inferInsert => ({
  id: version.id,
  topicId: version.topicId,
  documentId: version.documentId,
  documentContentHash: version.documentContentHash,
  version: version.version,
  status: version.status,
  supersedesId: version.supersedesId ?? null,
  summary: version.summary ?? null,
  createdAt: version.createdAt,
});

export class DrizzleResearchHypothesisVersionRepository
  implements ResearchHypothesisVersionRepository
{
  constructor(private readonly db: DrizzleDb) {}

  async create(version: ResearchHypothesisVersion): Promise<void> {
    assertResearchHypothesisVersionInvariants(version);
    if (version.status !== 'active') {
      throw new InvariantError('新 ResearchHypothesisVersion 必须为 active');
    }
    this.db.transaction((tx) => {
      if (
        tx
          .select({ id: researchHypothesisVersions.id })
          .from(researchHypothesisVersions)
          .where(eq(researchHypothesisVersions.id, version.id))
          .get() !== undefined
      ) {
        throw new InvariantError(`ResearchHypothesisVersion 已存在: ${version.id}`);
      }
      const versions = tx
        .select()
        .from(researchHypothesisVersions)
        .where(eq(researchHypothesisVersions.topicId, version.topicId))
        .all();
      if (versions.some((item) => item.version === version.version)) {
        throw new InvariantError('(topicId, version) 必须唯一');
      }
      const maxVersion = Math.max(0, ...versions.map((item) => item.version));
      if (version.version !== maxVersion + 1) {
        throw new InvariantError('ResearchHypothesisVersion.version 必须严格递增');
      }
      const active = versions.find((item) => item.status === 'active');
      if (active !== undefined && version.supersedesId !== active.id) {
        throw new InvariantError('新版本必须 supersede 当前 active ResearchHypothesisVersion');
      }
      if (version.supersedesId !== undefined) {
        const superseded = versions.find((item) => item.id === version.supersedesId);
        if (superseded === undefined) {
          throw new InvariantError('supersedesId 必须指向同一 Topic 的既有版本');
        }
      }
      if (active !== undefined) {
        tx.update(researchHypothesisVersions)
          .set({ status: 'superseded' })
          .where(eq(researchHypothesisVersions.id, active.id))
          .run();
      }
      tx.insert(researchHypothesisVersions).values(toRow(version)).run();
    });
  }

  async findById(id: string): Promise<ResearchHypothesisVersion | null> {
    const row = this.db
      .select()
      .from(researchHypothesisVersions)
      .where(eq(researchHypothesisVersions.id, id))
      .get();
    return row === undefined ? null : fromRow(row);
  }

  async list(
    input: NonNullable<Parameters<ResearchHypothesisVersionRepository['list']>[0]> = {},
  ): Promise<readonly ResearchHypothesisVersion[]> {
    const conditions: SQL[] = [];
    if (input.topicId !== undefined) {
      conditions.push(eq(researchHypothesisVersions.topicId, input.topicId));
    }
    if (input.status !== undefined) {
      conditions.push(eq(researchHypothesisVersions.status, input.status));
    }
    const where = conditions.length === 0 ? undefined : and(...conditions);
    return this.db
      .select()
      .from(researchHypothesisVersions)
      .where(where)
      .orderBy(desc(researchHypothesisVersions.version), desc(researchHypothesisVersions.createdAt))
      .limit(input.limit ?? 50)
      .all()
      .map(fromRow);
  }
}
