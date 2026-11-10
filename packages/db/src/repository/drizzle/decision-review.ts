import {
  type DecisionReview,
  type DecisionReviewRepository,
  DecisionReviewSchema,
} from '@luoome/core';
import { and, desc, eq, gte, lt, or } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { decisionReviews, type Schema } from '../../schema/index.js';

type ReviewRow = typeof decisionReviews.$inferSelect;

const toReview = (row: ReviewRow): DecisionReview =>
  DecisionReviewSchema.parse({
    id: row.id,
    accountId: row.accountId,
    subject: { kind: row.subjectKind, id: row.subjectId },
    stockId: row.stockId,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

export class DrizzleDecisionReviewRepository implements DecisionReviewRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async findBySubject(input: Parameters<DecisionReviewRepository['findBySubject']>[0]) {
    const row = this.db
      .select()
      .from(decisionReviews)
      .where(
        and(
          eq(decisionReviews.accountId, input.accountId),
          eq(decisionReviews.subjectKind, input.subject.kind),
          eq(decisionReviews.subjectId, input.subject.id),
        ),
      )
      .get();
    return row === undefined ? null : toReview(row);
  }

  async findById(input: Parameters<DecisionReviewRepository['findById']>[0]) {
    const row = this.db
      .select()
      .from(decisionReviews)
      .where(and(eq(decisionReviews.accountId, input.accountId), eq(decisionReviews.id, input.id)))
      .get();
    return row === undefined ? null : toReview(row);
  }

  async list(input: Parameters<DecisionReviewRepository['list']>[0]) {
    const rows = this.db
      .select()
      .from(decisionReviews)
      .where(
        and(
          eq(decisionReviews.accountId, input.accountId),
          input.stockId === undefined ? undefined : eq(decisionReviews.stockId, input.stockId),
          input.subjectKind === undefined
            ? undefined
            : eq(decisionReviews.subjectKind, input.subjectKind),
          input.subjectId === undefined
            ? undefined
            : eq(decisionReviews.subjectId, input.subjectId),
          input.since === undefined ? undefined : gte(decisionReviews.updatedAt, input.since),
          input.until === undefined ? undefined : lt(decisionReviews.updatedAt, input.until),
          input.cursor === undefined
            ? undefined
            : or(
                lt(decisionReviews.updatedAt, input.cursor.updatedAt),
                and(
                  eq(decisionReviews.updatedAt, input.cursor.updatedAt),
                  lt(decisionReviews.id, input.cursor.id),
                ),
              ),
        ),
      )
      .orderBy(desc(decisionReviews.updatedAt), desc(decisionReviews.id))
      .limit(input.limit ?? 50)
      .all();
    return rows.map(toReview);
  }

  async save(review: DecisionReview) {
    return this.db.transaction(
      (tx) => {
        tx.insert(decisionReviews)
          .values({
            id: review.id,
            accountId: review.accountId,
            subjectKind: review.subject.kind,
            subjectId: review.subject.id,
            stockId: review.stockId,
            content: review.content,
            createdAt: review.createdAt,
            updatedAt: review.updatedAt,
          })
          .onConflictDoUpdate({
            target: [
              decisionReviews.accountId,
              decisionReviews.subjectKind,
              decisionReviews.subjectId,
            ],
            set: {
              stockId: review.stockId,
              content: review.content,
              updatedAt: review.updatedAt,
            },
          })
          .run();
        const row = tx
          .select()
          .from(decisionReviews)
          .where(
            and(
              eq(decisionReviews.accountId, review.accountId),
              eq(decisionReviews.subjectKind, review.subject.kind),
              eq(decisionReviews.subjectId, review.subject.id),
            ),
          )
          .get();
        if (row === undefined) throw new Error('决策复盘写入后不可读');
        return toReview(row);
      },
      { behavior: 'immediate' },
    );
  }
}
