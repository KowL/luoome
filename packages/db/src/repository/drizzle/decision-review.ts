import { createHash } from 'node:crypto';
import {
  assertDecisionReviewContent,
  DecisionReviewContentSchema,
  DecisionReviewContextSchema,
  type DecisionReviewRepository,
  DecisionReviewRevisionSchema,
  DecisionReviewSchema,
  type DecisionReviewWithRevision,
  InvariantError,
  TradeSchema,
} from '@luoome/core';
import { and, desc, eq, gte, lt, lte, or, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import {
  decisionReviewRevisions,
  decisionReviews,
  decisionReviewTradeLinks,
  decisionWriteReceipts,
  type Schema,
  trades,
} from '../../schema/index.js';

type ReviewRow = typeof decisionReviews.$inferSelect;
type RevisionRow = typeof decisionReviewRevisions.$inferSelect;
const factHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const toReview = (row: ReviewRow) =>
  DecisionReviewSchema.parse({
    id: row.id,
    accountId: row.accountId,
    subject: { kind: row.subjectKind, id: row.subjectId },
    stockId: row.stockId,
    sourceOccurredAt: row.sourceOccurredAt,
    context: DecisionReviewContextSchema.parse(row.context),
    currentRevision: row.currentRevision,
    createdAt: row.createdAt,
  });
const toRevision = (row: RevisionRow) =>
  DecisionReviewRevisionSchema.parse({
    reviewId: row.reviewId,
    revision: row.revision,
    sequence: row.sequence,
    content: row.content,
    tradeFactHashes: row.tradeFactHashes,
    contentHash: row.contentHash,
    recordedAt: row.recordedAt,
    changeNote: row.changeNote,
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
    return row === undefined ? null : this.load(row);
  }

  async findById(input: Parameters<DecisionReviewRepository['findById']>[0]) {
    const row = this.db
      .select()
      .from(decisionReviews)
      .where(and(eq(decisionReviews.accountId, input.accountId), eq(decisionReviews.id, input.id)))
      .get();
    return row === undefined ? null : this.load(row, input.revision);
  }

  async latestSequence(accountId: string): Promise<number> {
    const row = this.db
      .select({ sequence: sql<number>`max(${decisionReviewRevisions.sequence})` })
      .from(decisionReviewRevisions)
      .innerJoin(decisionReviews, eq(decisionReviews.id, decisionReviewRevisions.reviewId))
      .where(eq(decisionReviews.accountId, accountId))
      .get();
    return row?.sequence ?? 0;
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
          input.throughSequence === undefined
            ? undefined
            : sql`exists (select 1 from decision_review_revisions r where r.review_id = ${decisionReviews.id} and r.sequence <= ${input.throughSequence})`,
          input.since === undefined
            ? undefined
            : gte(decisionReviews.sourceOccurredAt, input.since),
          input.until === undefined ? undefined : lt(decisionReviews.sourceOccurredAt, input.until),
          input.cursor === undefined
            ? undefined
            : or(
                lt(decisionReviews.sourceOccurredAt, input.cursor.occurredAt),
                and(
                  eq(decisionReviews.sourceOccurredAt, input.cursor.occurredAt),
                  lt(decisionReviews.id, input.cursor.id),
                ),
              ),
        ),
      )
      .orderBy(desc(decisionReviews.sourceOccurredAt), desc(decisionReviews.id))
      .limit(input.limit ?? 50)
      .all();
    const selected = rows.flatMap((row) => {
      if (input.throughSequence === undefined) {
        const item = this.load(row);
        return item === null ? [] : [item];
      }
      const revision = this.db
        .select()
        .from(decisionReviewRevisions)
        .where(
          and(
            eq(decisionReviewRevisions.reviewId, row.id),
            lte(decisionReviewRevisions.sequence, input.throughSequence),
          ),
        )
        .orderBy(desc(decisionReviewRevisions.sequence))
        .limit(1)
        .get();
      return revision === undefined
        ? []
        : [
            {
              review: { ...toReview(row), currentRevision: revision.revision },
              revision: toRevision(revision),
            },
          ];
    });
    return selected.slice(0, input.limit ?? 50);
  }

  async listActivity(input: Parameters<DecisionReviewRepository['listActivity']>[0]) {
    const rows = this.db
      .select({ review: decisionReviews, revision: decisionReviewRevisions })
      .from(decisionReviewRevisions)
      .innerJoin(decisionReviews, eq(decisionReviews.id, decisionReviewRevisions.reviewId))
      .where(
        and(
          eq(decisionReviews.accountId, input.accountId),
          input.stockId === undefined ? undefined : eq(decisionReviews.stockId, input.stockId),
          input.subjectKind === undefined
            ? undefined
            : eq(decisionReviews.subjectKind, input.subjectKind),
          input.since === undefined
            ? undefined
            : gte(decisionReviewRevisions.recordedAt, input.since),
          input.until === undefined
            ? undefined
            : lt(decisionReviewRevisions.recordedAt, input.until),
          input.throughSequence === undefined
            ? undefined
            : lte(decisionReviewRevisions.sequence, input.throughSequence),
          input.cursor === undefined
            ? undefined
            : or(
                lt(decisionReviewRevisions.recordedAt, input.cursor.recordedAt),
                and(
                  eq(decisionReviewRevisions.recordedAt, input.cursor.recordedAt),
                  lt(decisionReviewRevisions.sequence, input.cursor.sequence),
                ),
              ),
        ),
      )
      .orderBy(desc(decisionReviewRevisions.recordedAt), desc(decisionReviewRevisions.sequence))
      .limit(input.limit ?? 50)
      .all();
    return rows.map(({ review, revision }) => ({
      review: { ...toReview(review), currentRevision: revision.revision },
      revision: toRevision(revision),
    }));
  }

  async listRevisions(input: Parameters<DecisionReviewRepository['listRevisions']>[0]) {
    const parent = await this.findById({ accountId: input.accountId, id: input.reviewId });
    if (parent === null) return [];
    return this.db
      .select()
      .from(decisionReviewRevisions)
      .where(eq(decisionReviewRevisions.reviewId, input.reviewId))
      .orderBy(desc(decisionReviewRevisions.revision))
      .all()
      .map(toRevision);
  }

  async findWriteReceipt(input: Parameters<DecisionReviewRepository['findWriteReceipt']>[0]) {
    const row = this.db
      .select()
      .from(decisionWriteReceipts)
      .where(
        and(
          eq(decisionWriteReceipts.accountId, input.accountId),
          eq(decisionWriteReceipts.requestId, input.requestId),
        ),
      )
      .get();
    if (row === undefined || row.command !== 'save_decision_review') return null;
    const raw = row.result as DecisionReviewWithRevision;
    return {
      requestHash: row.requestHash,
      result: {
        review: DecisionReviewSchema.parse(raw.review),
        revision: DecisionReviewRevisionSchema.parse(raw.revision),
      },
    };
  }

  async commit(input: Parameters<DecisionReviewRepository['commit']>[0]) {
    return this.db.transaction(
      (tx) => {
        const receipt = tx
          .select()
          .from(decisionWriteReceipts)
          .where(
            and(
              eq(decisionWriteReceipts.accountId, input.accountId),
              eq(decisionWriteReceipts.requestId, input.requestId),
            ),
          )
          .get();
        if (receipt !== undefined) {
          if (
            receipt.requestHash !== input.requestHash ||
            receipt.command !== 'save_decision_review'
          ) {
            throw new InvariantError('请求 ID 已用于其他内容');
          }
          const raw = receipt.result as DecisionReviewWithRevision;
          return {
            result: {
              review: DecisionReviewSchema.parse(raw.review),
              revision: DecisionReviewRevisionSchema.parse(raw.revision),
            },
            replayed: true,
          };
        }
        if (input.accountId !== input.review.accountId) throw new InvariantError('账户归属不一致');
        const content = DecisionReviewContentSchema.parse(input.content);
        assertDecisionReviewContent(input.review.subject, content, input.expectedRevision === 0);
        const current = tx
          .select()
          .from(decisionReviews)
          .where(
            and(
              eq(decisionReviews.accountId, input.accountId),
              eq(decisionReviews.subjectKind, input.review.subject.kind),
              eq(decisionReviews.subjectId, input.review.subject.id),
            ),
          )
          .get();
        if ((current?.currentRevision ?? 0) !== input.expectedRevision) {
          throw new InvariantError('复盘记录已变化，请刷新后重新确认');
        }
        if (current !== undefined && current.id !== input.review.id)
          throw new InvariantError('记录身份不一致');
        if (current !== undefined && current.contextHash !== input.review.context.contextHash) {
          throw new InvariantError('原始依据快照已变化');
        }
        const oldRevision =
          current === undefined
            ? undefined
            : tx
                .select()
                .from(decisionReviewRevisions)
                .where(
                  and(
                    eq(decisionReviewRevisions.reviewId, current.id),
                    eq(decisionReviewRevisions.revision, current.currentRevision),
                  ),
                )
                .get();
        if (oldRevision !== undefined && oldRevision.contentHash === input.contentHash) {
          const result = { review: toReview(current!), revision: toRevision(oldRevision) };
          tx.insert(decisionWriteReceipts)
            .values({
              accountId: input.accountId,
              requestId: input.requestId,
              command: 'save_decision_review',
              requestHash: input.requestHash,
              result,
              committedAt: input.recordedAt,
            })
            .run();
          return { result, replayed: false };
        }
        if (oldRevision !== undefined) {
          const removed = oldRevision.content.tradeIds.filter(
            (id) => !content.tradeIds.includes(id),
          );
          if (
            (removed.length > 0 ||
              oldRevision.content.adviceFeedback?.pnl !== content.adviceFeedback?.pnl) &&
            !input.changeNote
          ) {
            throw new InvariantError('解除关联或修改已填盈亏需要填写更正原因');
          }
        }
        for (const tradeId of content.tradeIds) {
          const trade = tx.select().from(trades).where(eq(trades.id, tradeId)).get();
          if (trade === undefined || trade.accountId !== input.accountId)
            throw new InvariantError('关联成交不可用或不属于当前账户');
          if (input.review.stockId !== null && trade.stockId !== input.review.stockId)
            throw new InvariantError('关联成交的股票不匹配');
          if (trade.executedAt < input.review.sourceOccurredAt)
            throw new InvariantError('成交时间早于依据生成时间');
          const parsedTrade = TradeSchema.parse({
            ...trade,
            adviceId: trade.adviceId ?? undefined,
            researchHypothesisVersionId: trade.researchHypothesisVersionId ?? undefined,
            strategyVersionId: trade.strategyVersionId ?? undefined,
          });
          if (input.tradeFactHashes[tradeId] !== factHash(parsedTrade))
            throw new InvariantError('关联成交事实已变化，请刷新后重新确认');
        }
        const number = input.expectedRevision + 1;
        const review = DecisionReviewSchema.parse({ ...input.review, currentRevision: number });
        if (current === undefined) {
          tx.insert(decisionReviews)
            .values({
              id: review.id,
              accountId: review.accountId,
              subjectKind: review.subject.kind,
              subjectId: review.subject.id,
              stockId: review.stockId,
              sourceOccurredAt: review.sourceOccurredAt,
              context: review.context,
              contextHash: review.context.contextHash,
              currentRevision: number,
              createdAt: review.createdAt,
            })
            .run();
        } else {
          tx.update(decisionReviews)
            .set({ currentRevision: number })
            .where(eq(decisionReviews.id, review.id))
            .run();
        }
        const inserted = tx
          .insert(decisionReviewRevisions)
          .values({
            reviewId: review.id,
            revision: number,
            content,
            contentHash: input.contentHash,
            tradeFactHashes: { ...input.tradeFactHashes },
            recordedAt: input.recordedAt,
            changeNote: input.changeNote,
          })
          .returning()
          .get();
        tx.delete(decisionReviewTradeLinks)
          .where(eq(decisionReviewTradeLinks.reviewId, review.id))
          .run();
        for (const tradeId of content.tradeIds) {
          tx.insert(decisionReviewTradeLinks)
            .values({ reviewId: review.id, accountId: input.accountId, tradeId, revision: number })
            .run();
        }
        const result = { review, revision: toRevision(inserted) };
        tx.insert(decisionWriteReceipts)
          .values({
            accountId: input.accountId,
            requestId: input.requestId,
            command: 'save_decision_review',
            requestHash: input.requestHash,
            result,
            committedAt: input.recordedAt,
          })
          .run();
        return { result, replayed: false };
      },
      { behavior: 'immediate' },
    );
  }

  private load(row: ReviewRow, revision = row.currentRevision): DecisionReviewWithRevision | null {
    const found = this.db
      .select()
      .from(decisionReviewRevisions)
      .where(
        and(
          eq(decisionReviewRevisions.reviewId, row.id),
          eq(decisionReviewRevisions.revision, revision),
        ),
      )
      .get();
    return found === undefined ? null : { review: toReview(row), revision: toRevision(found) };
  }
}
