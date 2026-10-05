import { createHash } from 'node:crypto';
import {
  applyCashDelta,
  assertAccountInvariants,
  assertDecisionReviewContent,
  assertHoldingInvariants,
  assertLedgerHoldingUnchanged,
  assertTradeInvariants,
  cashImpactOfTrade,
  DecisionReviewContentSchema,
  type DecisionReviewRepository,
  DecisionReviewRevisionSchema,
  DecisionReviewSchema,
  type DecisionReviewWithRevision,
  DecisionTradeCommitResultSchema,
  type DecisionTradeRepository,
  decisionLedgerState,
  InvariantError,
} from '@luoome/core';
import type { InMemoryAccountRepository } from './account.js';

const factHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

import type { InMemoryHoldingRepository } from './holding.js';
import type { InMemoryLedgerRepository } from './ledger.js';
import type {
  InMemoryPortfolioCashFlowRepository,
  InMemoryPortfolioCorporateActionRepository,
} from './portfolio-performance.js';
import type { InMemoryTradeRepository } from './trade.js';
import type { MemoryWriteLock } from './write-lock.js';

export class InMemoryDecisionReviewRepository
  implements DecisionReviewRepository, DecisionTradeRepository
{
  private readonly records = new Map<string, DecisionReviewWithRevision>();
  private readonly history = new Map<string, DecisionReviewWithRevision['revision'][]>();
  private readonly receipts = new Map<
    string,
    { requestHash: string; result: DecisionReviewWithRevision }
  >();
  private readonly tradeReceipts = new Map<
    string,
    { requestHash: string; result: ReturnType<typeof DecisionTradeCommitResultSchema.parse> }
  >();
  private sequence = 0;

  constructor(
    private readonly trades: InMemoryTradeRepository,
    private readonly account: InMemoryAccountRepository,
    private readonly holding: InMemoryHoldingRepository,
    private readonly ledger: InMemoryLedgerRepository,
    private readonly cashFlows: InMemoryPortfolioCashFlowRepository,
    private readonly corporateActions: InMemoryPortfolioCorporateActionRepository,
    private readonly lock: MemoryWriteLock,
  ) {}

  async findBySubject(input: Parameters<DecisionReviewRepository['findBySubject']>[0]) {
    return (
      [...this.records.values()].find(
        ({ review }) =>
          review.accountId === input.accountId &&
          review.subject.kind === input.subject.kind &&
          review.subject.id === input.subject.id,
      ) ?? null
    );
  }

  async findById(input: Parameters<DecisionReviewRepository['findById']>[0]) {
    const current = this.records.get(input.id);
    if (current === undefined || current.review.accountId !== input.accountId) return null;
    if (input.revision === undefined) return current;
    const revision = this.history.get(input.id)?.find((item) => item.revision === input.revision);
    return revision === undefined ? null : { review: current.review, revision };
  }

  async latestSequence(accountId: string): Promise<number> {
    return Math.max(
      0,
      ...[...this.records.values()]
        .filter(({ review }) => review.accountId === accountId)
        .flatMap(({ review }) => this.history.get(review.id) ?? [])
        .map((revision) => revision.sequence),
    );
  }

  async list(input: Parameters<DecisionReviewRepository['list']>[0]) {
    return [...this.records.values()]
      .filter(
        ({ review }) =>
          review.accountId === input.accountId &&
          (input.stockId === undefined || review.stockId === input.stockId) &&
          (input.subjectKind === undefined || review.subject.kind === input.subjectKind) &&
          (input.since === undefined || review.sourceOccurredAt >= input.since) &&
          (input.until === undefined || review.sourceOccurredAt < input.until) &&
          (input.cursor === undefined ||
            review.sourceOccurredAt < input.cursor.occurredAt ||
            (review.sourceOccurredAt.getTime() === input.cursor.occurredAt.getTime() &&
              review.id < input.cursor.id)),
      )
      .flatMap(({ review, revision }) => {
        if (input.throughSequence === undefined) return [{ review, revision }];
        const selected = [...(this.history.get(review.id) ?? [])]
          .filter((item) => item.sequence <= input.throughSequence!)
          .sort((a, b) => b.sequence - a.sequence)[0];
        return selected === undefined
          ? []
          : [{ review: { ...review, currentRevision: selected.revision }, revision: selected }];
      })
      .sort(
        (a, b) =>
          b.review.sourceOccurredAt.getTime() - a.review.sourceOccurredAt.getTime() ||
          b.review.id.localeCompare(a.review.id),
      )
      .slice(0, input.limit ?? 50);
  }

  async listActivity(input: Parameters<DecisionReviewRepository['listActivity']>[0]) {
    return [...this.records.values()]
      .filter(
        ({ review }) =>
          review.accountId === input.accountId &&
          (input.stockId === undefined || review.stockId === input.stockId) &&
          (input.subjectKind === undefined || review.subject.kind === input.subjectKind),
      )
      .flatMap(({ review }) =>
        (this.history.get(review.id) ?? []).map((revision) => ({
          review: { ...review, currentRevision: revision.revision },
          revision,
        })),
      )
      .filter(
        ({ revision }) =>
          (input.since === undefined || revision.recordedAt >= input.since) &&
          (input.until === undefined || revision.recordedAt < input.until) &&
          (input.throughSequence === undefined || revision.sequence <= input.throughSequence) &&
          (input.cursor === undefined ||
            revision.recordedAt < input.cursor.recordedAt ||
            (revision.recordedAt.getTime() === input.cursor.recordedAt.getTime() &&
              revision.sequence < input.cursor.sequence)),
      )
      .sort(
        (a, b) =>
          b.revision.recordedAt.getTime() - a.revision.recordedAt.getTime() ||
          b.revision.sequence - a.revision.sequence,
      )
      .slice(0, input.limit ?? 50);
  }

  async listRevisions(input: Parameters<DecisionReviewRepository['listRevisions']>[0]) {
    const record = await this.findById({ accountId: input.accountId, id: input.reviewId });
    return record === null ? [] : [...(this.history.get(input.reviewId) ?? [])].reverse();
  }

  async findWriteReceipt(input: Parameters<DecisionReviewRepository['findWriteReceipt']>[0]) {
    return this.receipts.get(`${input.accountId}\0${input.requestId}`) ?? null;
  }

  async commit(input: Parameters<DecisionReviewRepository['commit']>[0]) {
    return this.lock.run(async () => {
      const receiptKey = `${input.accountId}\0${input.requestId}`;
      const receipt = this.receipts.get(receiptKey);
      if (receipt !== undefined) {
        if (receipt.requestHash !== input.requestHash)
          throw new InvariantError('请求 ID 已用于其他内容');
        return { result: receipt.result, replayed: true };
      }
      if (input.accountId !== input.review.accountId) throw new InvariantError('账户归属不一致');
      const content = DecisionReviewContentSchema.parse(input.content);
      assertDecisionReviewContent(input.review.subject, content, input.expectedRevision === 0);
      const old = await this.findBySubject({
        accountId: input.accountId,
        subject: input.review.subject,
      });
      if ((old?.review.currentRevision ?? 0) !== input.expectedRevision)
        throw new InvariantError('复盘记录已变化，请刷新后重新确认');
      if (old !== null && old.review.id !== input.review.id)
        throw new InvariantError('记录身份不一致');
      if (old !== null && old.review.context.contextHash !== input.review.context.contextHash)
        throw new InvariantError('原始依据快照已变化');
      if (old?.revision.contentHash === input.contentHash) {
        this.receipts.set(receiptKey, { requestHash: input.requestHash, result: old });
        return { result: old, replayed: false };
      }
      if (old !== null) {
        const removed = old.revision.content.tradeIds.filter(
          (id) => !content.tradeIds.includes(id),
        );
        if (
          (removed.length > 0 ||
            old.revision.content.adviceFeedback?.pnl !== content.adviceFeedback?.pnl) &&
          !input.changeNote
        ) {
          throw new InvariantError('解除关联或修改已填盈亏需要填写更正原因');
        }
      }
      for (const id of content.tradeIds) {
        const trade = await this.trades.findById(id);
        if (trade === null || trade.accountId !== input.accountId)
          throw new InvariantError('关联成交不可用或不属于当前账户');
        if (input.review.stockId !== null && trade.stockId !== input.review.stockId)
          throw new InvariantError('关联成交的股票不匹配');
        if (trade.executedAt < input.review.sourceOccurredAt)
          throw new InvariantError('成交时间早于依据生成时间');
        if (input.tradeFactHashes[id] !== factHash(trade))
          throw new InvariantError('关联成交事实已变化，请刷新后重新确认');
      }
      const number = input.expectedRevision + 1;
      const review = DecisionReviewSchema.parse({ ...input.review, currentRevision: number });
      const revision = DecisionReviewRevisionSchema.parse({
        reviewId: review.id,
        revision: number,
        sequence: this.sequence + 1,
        content,
        tradeFactHashes: input.tradeFactHashes,
        contentHash: input.contentHash,
        recordedAt: input.recordedAt,
        changeNote: input.changeNote,
      });
      const result = { review, revision };
      this.records.set(review.id, result);
      this.history.set(review.id, [...(this.history.get(review.id) ?? []), revision]);
      this.receipts.set(receiptKey, { requestHash: input.requestHash, result });
      this.sequence++;
      return { result, replayed: false };
    });
  }

  async getLedgerState(accountId: string) {
    const account = await this.account.findById(accountId);
    if (account === null) return null;
    return decisionLedgerState({
      account,
      holdings: await this.holding.listByAccount(accountId),
      trades: await this.trades.listByAccount(accountId),
      holdingAdjustments: await this.ledger.listHoldingAdjustments(accountId),
      cashFlows: await this.cashFlows.listByAccount(accountId),
      corporateActions: await this.corporateActions.listByAccount(accountId),
    });
  }

  async findReceipt(input: Parameters<DecisionTradeRepository['findReceipt']>[0]) {
    return this.tradeReceipts.get(`${input.accountId}\0${input.requestId}`) ?? null;
  }

  async commitTrade(input: Parameters<DecisionTradeRepository['commitTrade']>[0]) {
    return this.lock.run(async () => {
      const receiptKey = `${input.accountId}\0${input.requestId}`;
      const oldReceipt = this.tradeReceipts.get(receiptKey);
      if (oldReceipt !== undefined) {
        if (oldReceipt.requestHash !== input.requestHash)
          throw new InvariantError('请求 ID 已用于其他内容');
        return { result: oldReceipt.result, replayed: true };
      }
      if (this.receipts.has(receiptKey)) throw new InvariantError('请求 ID 已用于其他命令');
      assertTradeInvariants(input.trade);
      assertHoldingInvariants(input.holding);
      const state = await this.getLedgerState(input.accountId);
      if (state === null || state.hash !== input.expectedLedgerStateHash)
        throw new InvariantError('账本已变化，请刷新后重新确认');
      if (state.appendEligibility !== 'eligible')
        throw new InvariantError('账户账本尚未完成对账，不能顺序追加成交');
      if (
        input.trade.executedAt < state.appendFrom ||
        input.trade.executedAt > input.trade.createdAt
      )
        throw new InvariantError('成交时间不在账本顺序追加窗口内');
      if (
        input.trade.accountId !== input.accountId ||
        input.holding.accountId !== input.accountId ||
        input.trade.stockId !== input.holding.stockId
      )
        throw new InvariantError('交易、持仓与账户归属不一致');
      assertLedgerHoldingUnchanged(
        await this.holding.findByAccountAndStock(input.accountId, input.trade.stockId),
        input.previousHolding,
      );
      if (await this.trades.findById(input.trade.id)) throw new InvariantError('交易已记录');
      const previousAccount = await this.account.findById(input.accountId);
      if (previousAccount === null) throw new InvariantError('账户已不存在');
      const account = {
        ...previousAccount,
        cashBalance: applyCashDelta(previousAccount.cashBalance, cashImpactOfTrade(input.trade)),
      };
      assertAccountInvariants(account);
      const prepared: DecisionReviewWithRevision[] = [];
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
        const current = await this.findBySubject({
          accountId: input.accountId,
          subject: change.review.subject,
        });
        if (
          (current?.review.currentRevision ?? 0) !== change.expectedRevision ||
          (current !== null && current.review.id !== change.review.id)
        )
          throw new InvariantError('复盘修订已变化，请刷新后重新确认');
        if (
          current !== null &&
          current.review.context.contextHash !== change.review.context.contextHash
        )
          throw new InvariantError('来源快照已变化');
        for (const id of change.content.tradeIds) {
          if (id === input.trade.id) continue;
          const linked = await this.trades.findById(id);
          if (
            linked === null ||
            linked.accountId !== input.accountId ||
            (change.review.stockId !== null && linked.stockId !== change.review.stockId) ||
            linked.executedAt < change.review.sourceOccurredAt
          )
            throw new InvariantError('既有关联成交已失效');
        }
        const number = change.expectedRevision + 1;
        const review = DecisionReviewSchema.parse({ ...change.review, currentRevision: number });
        const revision = DecisionReviewRevisionSchema.parse({
          reviewId: review.id,
          revision: number,
          sequence: this.sequence + prepared.length + 1,
          content: change.content,
          tradeFactHashes: change.tradeFactHashes,
          contentHash: change.contentHash,
          recordedAt: input.trade.createdAt,
          changeNote: null,
        });
        prepared.push({ review, revision });
      }
      const result = DecisionTradeCommitResultSchema.parse({
        trade: input.trade,
        holding: input.holding,
        account,
        reviews: prepared,
      });
      this.account.put(account);
      this.holding.put(input.holding);
      this.trades.put(input.trade);
      for (const item of prepared) {
        this.records.set(item.review.id, item);
        this.history.set(item.review.id, [
          ...(this.history.get(item.review.id) ?? []),
          item.revision,
        ]);
      }
      this.sequence += prepared.length;
      this.tradeReceipts.set(receiptKey, { requestHash: input.requestHash, result });
      return { result, replayed: false };
    });
  }
}
