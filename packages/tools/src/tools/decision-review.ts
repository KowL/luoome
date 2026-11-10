import { createHash } from 'node:crypto';
import {
  assertDecisionReviewContent,
  DecisionReviewContentSchema,
  DecisionReviewSchema,
  type DecisionReviewSubject,
  DecisionReviewSubjectSchema,
  InvariantError,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const denied = (): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required: '当前账户的来源与成交' },
});

const subjectEntity = {
  advice: 'Advice',
  'trading-plan': 'TradingPlanVersion',
  trade: 'Trade',
} as const;

const resolveSubjectStock = async (
  ctx: ToolContext,
  accountId: string,
  subject: DecisionReviewSubject,
): Promise<{ readonly stockId: string | null } | null | 'denied'> => {
  if (subject.kind === 'advice') {
    const advice = await ctx.repos.advice.findById(subject.id);
    if (advice === null) return null;
    if (advice.subjectKind === 'stock') {
      const owner = advice.basedOn.strategy?.accountId;
      if (owner !== undefined && owner !== accountId) return 'denied';
      return { stockId: advice.subjectId };
    }
    if (advice.subjectKind === 'position') {
      const holding = await ctx.repos.holding.findById(advice.subjectId);
      if (holding === null) return null;
      if (holding.accountId !== accountId) return 'denied';
      return { stockId: holding.stockId };
    }
    if (advice.subjectKind === 'portfolio') {
      if (advice.subjectId !== accountId) return 'denied';
      return { stockId: null };
    }
    return 'denied';
  }
  if (subject.kind === 'trading-plan') {
    const plan = await ctx.repos.tradingPlan.findByVersionId(subject.id);
    if (plan === null) return null;
    if (plan.accountId !== accountId) return 'denied';
    return { stockId: plan.stockId };
  }
  const trade = await ctx.repos.trade.findById(subject.id);
  if (trade === null) return null;
  if (trade.accountId !== accountId) return 'denied';
  return { stockId: trade.stockId };
};

export const SaveDecisionReviewInput = z
  .object({
    accountId: z.string().min(1).optional(),
    subject: DecisionReviewSubjectSchema,
    content: DecisionReviewContentSchema,
  })
  .strict();

export const ListDecisionReviewsInput = z
  .object({
    accountId: z.string().min(1).optional(),
    subjectKind: DecisionReviewSubjectSchema.shape.kind.optional(),
    subjectId: z.string().min(1).optional(),
    stockId: z.string().min(1).optional(),
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict()
  .refine(
    (input) => input.since === undefined || input.until === undefined || input.since <= input.until,
    'until 必须不早于 since',
  );

const cursorSchema = z
  .object({
    accountId: z.string().min(1),
    filterHash: z.string().min(1),
    updatedAt: z.iso.datetime(),
    id: z.string().min(1),
  })
  .strict();

export const SaveDecisionReviewOutput = z.object({ review: DecisionReviewSchema });

export const saveDecisionReviewTool = defineTool({
  name: 'save_decision_review',
  description: '记录/更新某次建议、交易计划或成交的事后复盘（结论、教训标签、关联成交）',
  sideEffect: 'write',
  input: SaveDecisionReviewInput,
  output: SaveDecisionReviewOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!accountId || (await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const source = await resolveSubjectStock(ctx, accountId, input.subject);
    if (source === 'denied') return denied();
    if (source === null) return errNotFound(subjectEntity[input.subject.kind], input.subject.id);
    try {
      assertDecisionReviewContent(input.subject, input.content);
    } catch (error) {
      if (error instanceof InvariantError) return errInvalidInput(error.message);
      throw error;
    }
    for (const tradeId of input.content.tradeIds) {
      const trade = await ctx.repos.trade.findById(tradeId);
      if (trade === null) return errNotFound('Trade', tradeId);
      if (trade.accountId !== accountId) return denied();
      if (source.stockId !== null && trade.stockId !== source.stockId)
        return errInvalidInput('关联成交的股票与复盘对象不匹配');
    }
    const existing = await ctx.repos.decisionReview.findBySubject({
      accountId,
      subject: input.subject,
    });
    const now = ctx.clock();
    const review = DecisionReviewSchema.parse({
      id: existing?.id ?? digest([accountId, input.subject.kind, input.subject.id]),
      accountId,
      subject: input.subject,
      stockId: source.stockId,
      content: input.content,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { review: await ctx.repos.decisionReview.save(review) };
  },
});

export const ListDecisionReviewsOutput = z.object({
  accountId: z.string(),
  records: z.array(DecisionReviewSchema),
  nextCursor: z.string().nullable(),
});

export const listDecisionReviewsTool = defineTool({
  name: 'list_decision_reviews',
  description: '按账户、复盘对象与更新时间读取决策复盘记录（单表，游标分页）',
  sideEffect: 'read',
  input: ListDecisionReviewsInput,
  output: ListDecisionReviewsOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!accountId || (await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const filterHash = digest({
      accountId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      stockId: input.stockId,
      since: input.since?.toISOString(),
      until: input.until?.toISOString(),
    });
    let cursor: { readonly updatedAt: Date; readonly id: string } | undefined;
    if (input.cursor !== undefined) {
      try {
        const parsed = cursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')),
        );
        if (parsed.accountId !== accountId || parsed.filterHash !== filterHash)
          return errInvalidInput('复盘游标与账户或筛选不匹配');
        cursor = { updatedAt: new Date(parsed.updatedAt), id: parsed.id };
      } catch {
        return errInvalidInput('复盘游标无效，请重新开始查询');
      }
    }
    const filters = {
      accountId,
      ...(input.subjectKind === undefined ? {} : { subjectKind: input.subjectKind }),
      ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
      ...(input.stockId === undefined ? {} : { stockId: input.stockId }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
    };
    const page = await ctx.repos.decisionReview.list({
      ...filters,
      ...(cursor === undefined ? {} : { cursor }),
      limit: input.limit + 1,
    });
    const records = page.slice(0, input.limit);
    const last = records.at(-1);
    const nextCursor =
      page.length > input.limit && last !== undefined
        ? Buffer.from(
            JSON.stringify({
              accountId,
              filterHash,
              updatedAt: last.updatedAt.toISOString(),
              id: last.id,
            }),
          ).toString('base64url')
        : null;
    return { accountId, records, nextCursor };
  },
});
