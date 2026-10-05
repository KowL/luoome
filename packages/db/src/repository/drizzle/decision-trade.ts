import {
  AccountSchema,
  applyCashDelta,
  assertAccountInvariants,
  assertDecisionReviewContent,
  assertHoldingInvariants,
  assertLedgerHoldingUnchanged,
  assertTradeInvariants,
  cashImpactOfTrade,
  DecisionReviewRevisionSchema,
  DecisionReviewSchema,
  type DecisionTradeCommitResult,
  DecisionTradeCommitResultSchema,
  type DecisionTradeRepository,
  decisionLedgerState,
  HoldingSchema,
  InvariantError,
  type Trade,
  TradeSchema,
} from '@luoome/core';
import { and, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import {
  accounts,
  decisionReviewRevisions,
  decisionReviews,
  decisionReviewTradeLinks,
  decisionWriteReceipts,
  holdingCashAdjustments,
  holdings,
  portfolioCashFlows,
  portfolioCorporateActions,
  type Schema,
  trades,
} from '../../schema/index.js';

type Transaction = Parameters<Parameters<BunSQLiteDatabase<Schema>['transaction']>[0]>[0];

export class DrizzleDecisionTradeRepository implements DecisionTradeRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async getLedgerState(accountId: string) {
    return this.state(this.db, accountId);
  }

  async findReceipt(input: Parameters<DecisionTradeRepository['findReceipt']>[0]) {
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
    if (row === undefined || row.command !== 'record_decision_trade') return null;
    return {
      requestHash: row.requestHash,
      result: DecisionTradeCommitResultSchema.parse(row.result),
    };
  }

  async commitTrade(input: Parameters<DecisionTradeRepository['commitTrade']>[0]) {
    assertTradeInvariants(input.trade);
    assertHoldingInvariants(input.holding);
    return this.db.transaction(
      (tx) => {
        const existingReceipt = tx
          .select()
          .from(decisionWriteReceipts)
          .where(
            and(
              eq(decisionWriteReceipts.accountId, input.accountId),
              eq(decisionWriteReceipts.requestId, input.requestId),
            ),
          )
          .get();
        if (existingReceipt !== undefined) {
          if (
            existingReceipt.command !== 'record_decision_trade' ||
            existingReceipt.requestHash !== input.requestHash
          ) {
            throw new InvariantError('请求 ID 已用于其他内容');
          }
          return {
            result: DecisionTradeCommitResultSchema.parse(existingReceipt.result),
            replayed: true,
          };
        }
        const state = this.state(tx, input.accountId);
        if (state === null || state.hash !== input.expectedLedgerStateHash)
          throw new InvariantError('账本已变化，请刷新后重新确认');
        if (state.appendEligibility !== 'eligible')
          throw new InvariantError('账户账本尚未完成对账，不能顺序追加成交');
        if (
          input.trade.executedAt < state.appendFrom ||
          input.trade.executedAt > input.trade.createdAt
        ) {
          throw new InvariantError('成交时间不在账本顺序追加窗口内');
        }
        if (
          input.trade.accountId !== input.accountId ||
          input.holding.accountId !== input.accountId ||
          input.trade.stockId !== input.holding.stockId
        ) {
          throw new InvariantError('交易、持仓与账户归属不一致');
        }
        const currentHoldingRow = tx
          .select()
          .from(holdings)
          .where(
            and(eq(holdings.accountId, input.accountId), eq(holdings.stockId, input.trade.stockId)),
          )
          .get();
        assertLedgerHoldingUnchanged(
          currentHoldingRow === undefined ? null : HoldingSchema.parse(currentHoldingRow),
          input.previousHolding,
        );
        if (tx.select().from(trades).where(eq(trades.id, input.trade.id)).get())
          throw new InvariantError('交易已记录');
        const accountRow = tx.select().from(accounts).where(eq(accounts.id, input.accountId)).get();
        if (accountRow === undefined) throw new InvariantError('账户已不存在');
        const account = AccountSchema.parse({
          ...accountRow,
          cashBalance: applyCashDelta(accountRow.cashBalance, cashImpactOfTrade(input.trade)),
        });
        assertAccountInvariants(account);
        const seen = new Set<string>();
        for (const change of input.changes) {
          if (change.review.accountId !== input.accountId)
            throw new InvariantError('复盘账户归属不一致');
          if (seen.has(change.review.id)) throw new InvariantError('同一来源不能重复关联');
          seen.add(change.review.id);
          assertDecisionReviewContent(
            change.review.subject,
            change.content,
            change.expectedRevision === 0,
          );
          if (!change.content.tradeIds.includes(input.trade.id))
            throw new InvariantError('新增成交必须明确出现在关联内容中');
          if (change.review.stockId !== null && change.review.stockId !== input.trade.stockId)
            throw new InvariantError('复盘股票与成交不一致');
          if (input.trade.executedAt < change.review.sourceOccurredAt)
            throw new InvariantError('成交早于原始依据');
          const current = tx
            .select()
            .from(decisionReviews)
            .where(
              and(
                eq(decisionReviews.accountId, input.accountId),
                eq(decisionReviews.subjectKind, change.review.subject.kind),
                eq(decisionReviews.subjectId, change.review.subject.id),
              ),
            )
            .get();
          if (
            (current?.currentRevision ?? 0) !== change.expectedRevision ||
            (current !== undefined && current.id !== change.review.id)
          ) {
            throw new InvariantError('复盘修订已变化，请刷新后重新确认');
          }
          if (current !== undefined && current.contextHash !== change.review.context.contextHash)
            throw new InvariantError('来源快照已变化');
          for (const linkedId of change.content.tradeIds) {
            if (linkedId === input.trade.id) continue;
            const linked = tx.select().from(trades).where(eq(trades.id, linkedId)).get();
            if (
              linked === undefined ||
              linked.accountId !== input.accountId ||
              (change.review.stockId !== null && linked.stockId !== change.review.stockId) ||
              linked.executedAt < change.review.sourceOccurredAt
            )
              throw new InvariantError('既有关联成交已失效');
          }
        }
        tx.update(accounts)
          .set({ cashBalance: account.cashBalance })
          .where(eq(accounts.id, input.accountId))
          .run();
        tx.insert(holdings)
          .values(input.holding)
          .onConflictDoUpdate({ target: holdings.id, set: input.holding })
          .run();
        tx.insert(trades)
          .values({
            ...input.trade,
            adviceId: input.trade.adviceId ?? null,
            researchHypothesisVersionId: input.trade.researchHypothesisVersionId ?? null,
            strategyVersionId: input.trade.strategyVersionId ?? null,
          })
          .run();
        const reviews: DecisionTradeCommitResult['reviews'][number][] = [];
        for (const change of input.changes) {
          const number = change.expectedRevision + 1;
          const review = DecisionReviewSchema.parse({ ...change.review, currentRevision: number });
          if (change.expectedRevision === 0) {
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
          } else
            tx.update(decisionReviews)
              .set({ currentRevision: number })
              .where(eq(decisionReviews.id, review.id))
              .run();
          const row = tx
            .insert(decisionReviewRevisions)
            .values({
              reviewId: review.id,
              revision: number,
              content: change.content,
              contentHash: change.contentHash,
              tradeFactHashes: { ...change.tradeFactHashes },
              recordedAt: input.trade.createdAt,
              changeNote: null,
            })
            .returning()
            .get();
          tx.delete(decisionReviewTradeLinks)
            .where(eq(decisionReviewTradeLinks.reviewId, review.id))
            .run();
          for (const tradeId of change.content.tradeIds)
            tx.insert(decisionReviewTradeLinks)
              .values({
                reviewId: review.id,
                accountId: input.accountId,
                tradeId,
                revision: number,
              })
              .run();
          reviews.push({
            review,
            revision: DecisionReviewRevisionSchema.parse({
              ...row,
              tradeFactHashes: row.tradeFactHashes,
              content: row.content,
            }),
          });
        }
        const result = DecisionTradeCommitResultSchema.parse({
          trade: input.trade,
          holding: input.holding,
          account,
          reviews,
        });
        tx.insert(decisionWriteReceipts)
          .values({
            accountId: input.accountId,
            requestId: input.requestId,
            command: 'record_decision_trade',
            requestHash: input.requestHash,
            result,
            committedAt: input.trade.createdAt,
          })
          .run();
        return { result, replayed: false };
      },
      { behavior: 'immediate' },
    );
  }

  private state(source: BunSQLiteDatabase<Schema> | Transaction, accountId: string) {
    const account = source.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (account === undefined) return null;
    const holdingRows = source
      .select()
      .from(holdings)
      .where(eq(holdings.accountId, accountId))
      .all();
    const tradeRows = source.select().from(trades).where(eq(trades.accountId, accountId)).all();
    const adjustmentRows = source
      .select()
      .from(holdingCashAdjustments)
      .where(eq(holdingCashAdjustments.accountId, accountId))
      .all();
    const flowRows = source
      .select()
      .from(portfolioCashFlows)
      .where(eq(portfolioCashFlows.accountId, accountId))
      .all();
    const actionRows = source
      .select()
      .from(portfolioCorporateActions)
      .where(eq(portfolioCorporateActions.accountId, accountId))
      .all();
    return decisionLedgerState({
      account: AccountSchema.parse(account),
      holdings: holdingRows.map((row) => HoldingSchema.parse(row)),
      trades: tradeRows.map(
        (row) =>
          TradeSchema.parse({
            ...row,
            adviceId: row.adviceId ?? undefined,
            researchHypothesisVersionId: row.researchHypothesisVersionId ?? undefined,
            strategyVersionId: row.strategyVersionId ?? undefined,
          }) as Trade,
      ),
      holdingAdjustments: adjustmentRows,
      cashFlows: flowRows.map((row) => ({
        ...row,
        stockId: row.stockId ?? undefined,
        note: row.note ?? undefined,
      })),
      corporateActions: actionRows.map((row) => ({
        ...row,
        ratio: row.ratio ?? undefined,
        cashPerShare: row.cashPerShare ?? undefined,
        note: row.note ?? undefined,
      })),
    });
  }
}
