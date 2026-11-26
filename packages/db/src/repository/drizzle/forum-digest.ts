import {
  assertForumDigestInvariants,
  type ForumDigest,
  type ForumDigestRepository,
  type ForumDigestSubjectKind,
  type StockBriefPhase,
} from '@luoome/core';
import { and, asc, desc, eq, inArray, lt, type SQL } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { forumDigests, type Schema } from '../../schema/index.js';
import { RepositoryWriteScope } from '../../write-scope.js';

type Row = typeof forumDigests.$inferSelect;

const toDigest = (row: Row): ForumDigest => ({
  id: row.id,
  subjectKind: row.subjectKind,
  subjectId: row.subjectId,
  tradingDate: row.tradingDate,
  phase: row.phase,
  source: row.source,
  dataAsOf: row.dataAsOf,
  windowStart: row.windowStart,
  windowEnd: row.windowEnd,
  coverage: row.coverage,
  quality: row.quality,
  attention: row.attention,
  ...(row.breadth === null ? {} : { breadth: row.breadth }),
  stance: row.stance ?? null,
  excerpts: [...row.excerpts],
  consistency: row.consistency,
  missing: [...row.missing],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toRow = (digest: ForumDigest): Row => ({
  id: digest.id,
  subjectKind: digest.subjectKind,
  subjectId: digest.subjectId,
  tradingDate: digest.tradingDate,
  phase: digest.phase,
  source: digest.source,
  dataAsOf: digest.dataAsOf,
  windowStart: digest.windowStart,
  windowEnd: digest.windowEnd,
  coverage: digest.coverage,
  quality: digest.quality,
  attention: digest.attention,
  breadth: digest.breadth ?? null,
  stance: digest.stance ?? null,
  excerpts: digest.excerpts.map((item) => ({ ...item })),
  consistency: digest.consistency,
  missing: digest.missing.map((item) => ({ ...item })),
  createdAt: digest.createdAt,
  updatedAt: digest.updatedAt,
});

/**
 * 股吧讨论摘要仓储。
 *
 * 唯一键 (subjectKind, subjectId, tradingDate, phase) 上覆盖写：同日同阶段重跑只更新
 * 该行，不新增第二行；`id` 由调用方生成，覆盖时保留最新一次写入的 id。
 */
export class DrizzleForumDigestRepository implements ForumDigestRepository {
  constructor(
    private readonly db: BunSQLiteDatabase<Schema>,
    private readonly writes = new RepositoryWriteScope(),
  ) {}

  async upsert(digest: ForumDigest): Promise<ForumDigest> {
    assertForumDigestInvariants(digest);
    return this.writes.transaction(this.db, (tx) => {
      const existing = tx
        .select()
        .from(forumDigests)
        .where(
          and(
            eq(forumDigests.subjectKind, digest.subjectKind),
            eq(forumDigests.subjectId, digest.subjectId),
            eq(forumDigests.tradingDate, digest.tradingDate),
            eq(forumDigests.phase, digest.phase),
          ),
        )
        .get();
      if (existing === undefined) {
        tx.insert(forumDigests).values(toRow(digest)).run();
        return digest;
      }
      const next: ForumDigest = {
        ...digest,
        id: existing.id,
        createdAt: existing.createdAt,
      };
      assertForumDigestInvariants(next);
      tx.update(forumDigests).set(toRow(next)).where(eq(forumDigests.id, existing.id)).run();
      return next;
    });
  }

  async find(input: {
    readonly subjectKind: ForumDigestSubjectKind;
    readonly subjectId: string;
    readonly tradingDate: string;
    readonly phase: StockBriefPhase;
  }): Promise<ForumDigest | null> {
    const row = this.db
      .select()
      .from(forumDigests)
      .where(
        and(
          eq(forumDigests.subjectKind, input.subjectKind),
          eq(forumDigests.subjectId, input.subjectId),
          eq(forumDigests.tradingDate, input.tradingDate),
          eq(forumDigests.phase, input.phase),
        ),
      )
      .get();
    return row === undefined ? null : toDigest(row);
  }

  async findByDay(input: {
    readonly tradingDate: string;
    readonly phase?: StockBriefPhase;
    readonly subjectKinds?: readonly ForumDigestSubjectKind[];
    readonly subjectIds?: readonly string[];
  }): Promise<ForumDigest[]> {
    const conditions: SQL[] = [eq(forumDigests.tradingDate, input.tradingDate)];
    if (input.phase !== undefined) conditions.push(eq(forumDigests.phase, input.phase));
    if (input.subjectKinds !== undefined && input.subjectKinds.length > 0) {
      conditions.push(inArray(forumDigests.subjectKind, [...input.subjectKinds]));
    }
    if (input.subjectIds !== undefined) {
      if (input.subjectIds.length === 0) return [];
      conditions.push(inArray(forumDigests.subjectId, [...input.subjectIds]));
    }
    return this.db
      .select()
      .from(forumDigests)
      .where(and(...conditions))
      .orderBy(asc(forumDigests.subjectKind), asc(forumDigests.subjectId))
      .all()
      .map(toDigest);
  }

  async history(input: {
    readonly subjectKind: ForumDigestSubjectKind;
    readonly subjectId: string;
    readonly before: string;
    readonly phase?: StockBriefPhase;
    readonly limit?: number;
  }): Promise<ForumDigest[]> {
    const conditions: SQL[] = [
      eq(forumDigests.subjectKind, input.subjectKind),
      eq(forumDigests.subjectId, input.subjectId),
      lt(forumDigests.tradingDate, input.before),
    ];
    if (input.phase !== undefined) conditions.push(eq(forumDigests.phase, input.phase));
    return this.db
      .select()
      .from(forumDigests)
      .where(and(...conditions))
      .orderBy(desc(forumDigests.tradingDate))
      .limit(Math.min(60, Math.max(1, Math.trunc(input.limit ?? 20))))
      .all()
      .map(toDigest);
  }
}
