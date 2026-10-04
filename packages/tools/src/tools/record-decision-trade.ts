import { createHash } from 'node:crypto';
import {
  applyTradeToHolding,
  DecisionReviewSubjectSchema,
  DecisionTradeCommitResultSchema,
  type Holding,
  InvariantError,
  money,
  quantity,
  type Trade,
  TradeSideSchema,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { STOCK_ID_PATTERN } from '../internal/manual-entry.js';
import { getDecisionReviewContextTool } from './decision-review.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const RecordDecisionTradeInput = z
  .object({
    requestId: z.uuid(),
    accountId: z.string().min(1).optional(),
    expectedLedgerStateHash: z.string().min(1),
    confirmedNotRecorded: z.literal(true),
    stockId: z.string().regex(STOCK_ID_PATTERN),
    side: TradeSideSchema,
    quantity: z.number().int().positive(),
    price: z.number().positive().finite(),
    fee: z.number().nonnegative().finite().default(0),
    executedAt: z.string().regex(/(?:Z|[+-]\d{2}:\d{2})$/, '成交时间必须包含时区'),
    sources: z
      .array(
        z
          .object({
            subject: DecisionReviewSubjectSchema,
            contextHash: z.string().min(1),
            expectedRevision: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .superRefine((input, issue) => {
    if (
      new Set(input.sources.map(({ subject }) => `${subject.kind}\0${subject.id}`)).size !==
      input.sources.length
    ) {
      issue.addIssue({ code: 'custom', message: '同一来源只能选择一次', path: ['sources'] });
    }
    if (Number.isNaN(Date.parse(input.executedAt)))
      issue.addIssue({ code: 'custom', message: '成交时间无效', path: ['executedAt'] });
  });

export const RecordDecisionTradeOutput = z.object({
  requestId: z.string(),
  result: DecisionTradeCommitResultSchema,
  replayed: z.boolean(),
});

export const recordDecisionTradeTool = defineTool({
  name: 'record_decision_trade',
  description: '登记已在系统外完成、尚未入账的成交，并原子关联明确选择的当时依据',
  sideEffect: 'trade',
  input: RecordDecisionTradeInput,
  output: RecordDecisionTradeOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!accountId || (await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const requestHash = digest({
      command: 'record_decision_trade',
      accountId,
      expectedLedgerStateHash: input.expectedLedgerStateHash,
      confirmedNotRecorded: true,
      stockId: input.stockId,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      fee: input.fee,
      executedAt: new Date(input.executedAt).toISOString(),
      sources: [...input.sources].sort((a, b) =>
        `${a.subject.kind}\0${a.subject.id}`.localeCompare(`${b.subject.kind}\0${b.subject.id}`),
      ),
    });
    const receipt = await ctx.repos.decisionTrade.findReceipt({
      accountId,
      requestId: input.requestId,
    });
    if (receipt !== null) {
      if (receipt.requestHash !== requestHash) return errInvalidInput('请求 ID 已用于其他内容');
      return { requestId: input.requestId, result: receipt.result, replayed: true };
    }
    const stock = await ctx.repos.stock.findById(input.stockId);
    if (stock === null) return errNotFound('Stock', input.stockId);
    const ledgerState = await ctx.repos.decisionTrade.getLedgerState(accountId);
    if (ledgerState === null) return errNotFound('Account', accountId);
    if (ledgerState.hash !== input.expectedLedgerStateHash)
      throw new InvariantError('账本已变化，请刷新后重新确认');
    if (ledgerState.appendEligibility !== 'eligible')
      throw new InvariantError(`账本尚未对账：${ledgerState.reasons.join('；')}`);
    const now = ctx.clock();
    const executedAt = new Date(input.executedAt);
    if (executedAt > now || executedAt < ledgerState.appendFrom)
      return errInvalidInput('成交时间不在允许的顺序追加窗口内');
    const adviceSources = input.sources.filter(({ subject }) => subject.kind === 'advice');
    const trade: Trade = {
      id: `trade-${crypto.randomUUID()}`,
      accountId,
      stockId: input.stockId,
      side: input.side,
      quantity: quantity(input.quantity),
      price: money(input.price),
      fee: money(input.fee),
      executedAt,
      source: 'manual',
      createdAt: now,
      ...(adviceSources.length === 1 ? { adviceId: adviceSources[0]!.subject.id } : {}),
    };
    const previousHolding = await ctx.repos.holding.findByAccountAndStock(accountId, input.stockId);
    let holding: Holding;
    try {
      holding = applyTradeToHolding(previousHolding, trade, `holding-${crypto.randomUUID()}`);
    } catch (error) {
      if (error instanceof InvariantError) return errInvalidInput(error.message);
      throw error;
    }
    const tradeHash = digest(trade);
    const changes = [];
    for (const selected of input.sources) {
      const preview = await getDecisionReviewContextTool.execute(
        { accountId, subject: selected.subject },
        ctx,
      );
      if (!preview.ok) return preview;
      const { context, current, stockId, sourceOccurredAt } = preview.data;
      if (context === null || sourceOccurredAt === null || stockId !== input.stockId)
        return errInvalidInput('来源与成交股票不匹配或已失效');
      if (context.contextHash !== selected.contextHash)
        throw new InvariantError('来源已变化，请刷新后重新确认');
      if ((current?.review.currentRevision ?? 0) !== selected.expectedRevision)
        throw new InvariantError('复盘修订已变化，请刷新后重新确认');
      const old = current?.revision.content;
      const content = {
        tradeIds: [...new Set([...(old?.tradeIds ?? []), trade.id])].sort(),
        adviceFeedback: old?.adviceFeedback ?? null,
        triggerFeedback: old?.triggerFeedback ?? null,
        note: old?.note ?? null,
      };
      changes.push({
        expectedRevision: selected.expectedRevision,
        review: current?.review ?? {
          id: digest([accountId, selected.subject.kind, selected.subject.id]),
          accountId,
          subject: selected.subject,
          stockId,
          sourceOccurredAt,
          context,
          createdAt: now,
        },
        content,
        contentHash: digest(content),
        tradeFactHashes: { ...(current?.revision.tradeFactHashes ?? {}), [trade.id]: tradeHash },
      });
    }
    const committed = await ctx.repos.decisionTrade.commitTrade({
      accountId,
      requestId: input.requestId,
      requestHash,
      expectedLedgerStateHash: input.expectedLedgerStateHash,
      previousHolding,
      trade,
      holding,
      changes,
    });
    return { requestId: input.requestId, ...committed };
  },
});
