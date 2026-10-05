import { createHash } from 'node:crypto';
import {
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
  DecisionReviewContentSchema,
  DecisionReviewContextSchema,
  DecisionReviewRevisionSchema,
  DecisionReviewSchema,
  type DecisionReviewSubject,
  DecisionReviewSubjectSchema,
  DecisionTradeCommitResultSchema,
  SignalObservationSchema,
  type ToolContext,
  type ToolResult,
  TradeSchema,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshot = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value));
const denied = (): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required: '当前账户的来源与成交' },
});

const resolveSource = async (
  ctx: ToolContext,
  accountId: string,
  subject: DecisionReviewSubject,
) => {
  if (subject.kind === 'advice') {
    const advice = await ctx.repos.advice.findById(subject.id);
    if (advice === null) return null;
    let stockId: string | null = null;
    if (advice.subjectKind === 'stock') {
      stockId = advice.subjectId;
      const owner = advice.basedOn.strategy?.accountId;
      if (owner !== undefined && owner !== accountId) return 'denied' as const;
    } else if (advice.subjectKind === 'position') {
      const holding = await ctx.repos.holding.findById(advice.subjectId);
      if (holding === null) return null;
      if (holding.accountId !== accountId) return 'denied' as const;
      stockId = holding.stockId;
    } else if (advice.subjectKind === 'portfolio') {
      if (advice.subjectId !== accountId) return 'denied' as const;
    } else return 'denied' as const;
    const { outcome: _outcome, ...original } = advice;
    return {
      stockId,
      occurredAt: advice.createdAt,
      validUntil: advice.validUntil,
      sourceDataAsOf: advice.basedOn.dataAsOf,
      source: snapshot(original),
    };
  }
  if (subject.kind === 'trading-plan-version') {
    const plan = await ctx.repos.tradingPlan.findByVersionId(subject.id);
    if (plan === null) return null;
    if (plan.accountId !== accountId) return 'denied' as const;
    return {
      stockId: plan.stockId,
      occurredAt: plan.createdAt,
      validUntil: plan.validUntil,
      sourceDataAsOf: plan.accountFactsAsOf,
      source: snapshot(plan),
    };
  }
  const trigger = await ctx.repos.watchTrigger.findById(subject.id);
  if (trigger === null) return null;
  if (trigger.poolId.startsWith('trading-plan-watch:')) {
    if (trigger.poolId !== `trading-plan-watch:${accountId}`) return 'denied' as const;
    const versionId = trigger.evalSnapshot.planVersionId;
    if (typeof versionId !== 'string') return null;
    const plan = await ctx.repos.tradingPlan.findByVersionId(versionId);
    if (plan === null || plan.accountId !== accountId || plan.stockId !== trigger.stockId)
      return 'denied' as const;
  } else if (trigger.alertPlanId !== undefined) {
    const plan = await ctx.repos.alertPlan.findById(trigger.alertPlanId);
    if (plan === null) {
      if (trigger.poolId !== 'holdings-watch') return null;
      if ((await ctx.repos.holding.findByAccountAndStock(accountId, trigger.stockId)) === null)
        return 'denied' as const;
    } else {
      const watchlist = await ctx.repos.watchlist.findById(plan.watchlistId);
      if (watchlist === null) return null;
      if (watchlist.kind === 'portfolio') {
        const member = await ctx.repos.watchlistMember.findMember(watchlist.id, trigger.stockId);
        if (member === null) return 'denied' as const;
        const source = await ctx.repos.watchlistMember.currentSource(
          member.id,
          `portfolio:${accountId}`,
        );
        if (source?.sourceId !== accountId || source.kind !== 'portfolio') return 'denied' as const;
      }
    }
  }
  const {
    feedback: _feedback,
    feedbackAt: _feedbackAt,
    deliveryStatus: _deliveryStatus,
    notificationId: _notificationId,
    deliveryAttempts: _deliveryAttempts,
    lastDeliveryAttemptAt: _lastDeliveryAttemptAt,
    deliveryCompletedAt: _deliveryCompletedAt,
    notified: _notified,
    ...original
  } = trigger;
  return {
    stockId: trigger.stockId,
    occurredAt: trigger.createdAt,
    validUntil: null,
    sourceDataAsOf: trigger.quote?.ts ?? null,
    source: snapshot(original),
  };
};

const explicitObservations = async (
  ctx: ToolContext,
  subject: DecisionReviewSubject,
  stockId: string | null,
) => {
  if (stockId === null) return [];
  if (subject.kind === 'watch-trigger') {
    return (
      await ctx.repos.signalObservation.listBySources({
        sourceKind: 'watch-trigger',
        sourceIds: [subject.id],
        horizons: ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
      })
    ).filter((item) => item.stockId === stockId && item.sourceId === subject.id);
  }
  const adviceIds =
    subject.kind === 'advice'
      ? [subject.id]
      : ((await ctx.repos.tradingPlan.findByVersionId(subject.id))?.source.adviceIds ?? []);
  const seen = new Map<string, z.infer<typeof SignalObservationSchema>>();
  for (const id of adviceIds) {
    const advice = await ctx.repos.advice.findById(id);
    const evidence = advice?.basedOn.strategy;
    if (
      advice === null ||
      evidence === undefined ||
      evidence.stockId !== stockId ||
      !evidence.runId ||
      !evidence.strategyVersionId ||
      evidence.signalIds.length === 0
    )
      continue;
    const allowed = new Set(evidence.observationIds);
    const rows = await ctx.repos.signalObservation.listBySources({
      sourceKind: 'strategy-signal',
      sourceIds: evidence.signalIds,
      horizons: ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
    });
    for (const row of rows)
      if (
        row.stockId === stockId &&
        allowed.has(row.id) &&
        evidence.signalIds.includes(row.sourceId)
      )
        seen.set(row.id, row);
  }
  return [...seen.values()];
};

const SubjectInput = z
  .object({
    accountId: z.string().min(1).optional(),
    subject: DecisionReviewSubjectSchema,
    revision: z.number().int().positive().optional(),
  })
  .strict();
const ReviewViewSchema = z.object({
  review: DecisionReviewSchema,
  revision: DecisionReviewRevisionSchema,
});

export const getDecisionReviewContextTool = defineTool({
  name: 'get_decision_review_context',
  description: '读取当时依据快照、账户复盘记录及当前来源状态',
  sideEffect: 'read',
  input: SubjectInput,
  output: z.object({
    accountId: z.string(),
    sourceStatus: z.enum(['available', 'unavailable']),
    context: DecisionReviewContextSchema.nullable(),
    current: ReviewViewSchema.nullable(),
    validUntil: z.coerce.date().nullable(),
    stockId: z.string().nullable(),
    sourceOccurredAt: z.coerce.date().nullable(),
    selectedRevision: z.number().int().positive().nullable(),
    selected: ReviewViewSchema.nullable(),
    revisions: z.array(DecisionReviewRevisionSchema),
    ledgerState: z
      .object({
        hash: z.string(),
        appendFrom: z.coerce.date(),
        appendEligibility: z.enum(['eligible', 'unavailable']),
        reasons: z.array(z.string()),
      })
      .nullable(),
    candidateTrades: z.array(TradeSchema),
    observations: z.array(SignalObservationSchema),
    observationStatus: z.enum(['available', 'unavailable']),
    observationReason: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!accountId || (await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const current = await ctx.repos.decisionReview.findBySubject({
      accountId,
      subject: input.subject,
    });
    const selected =
      current === null || input.revision === undefined
        ? current
        : await ctx.repos.decisionReview.findById({
            accountId,
            id: current.review.id,
            revision: input.revision,
          });
    if (input.revision !== undefined && selected === null)
      return errNotFound('DecisionReviewRevision', `${input.subject.id}:${input.revision}`);
    const revisions =
      current === null
        ? []
        : await ctx.repos.decisionReview.listRevisions({ accountId, reviewId: current.review.id });
    const source = await resolveSource(ctx, accountId, input.subject);
    if (source === 'denied') return denied();
    if (source === null && current === null)
      return errNotFound('DecisionReviewSource', input.subject.id);
    const context =
      current?.review.context ??
      (source === null
        ? null
        : {
            schemaVersion: 1 as const,
            capturedAt: ctx.clock(),
            sourceDataAsOf: source.sourceDataAsOf,
            captureOrigin: 'user' as const,
            source: source.source,
            contextHash: digest({ subject: input.subject, source: source.source }),
          });
    const ledgerState = await ctx.repos.decisionTrade.getLedgerState(accountId);
    const stockId = current?.review.stockId ?? source?.stockId ?? null;
    const occurredAt = current?.review.sourceOccurredAt ?? source?.occurredAt ?? null;
    const eligible = await ctx.repos.trade.listByAccount(accountId, {
      ...(stockId === null ? {} : { stockId }),
      ...(occurredAt === null ? {} : { executedAtFrom: occurredAt }),
      order: 'desc',
      limit: 20,
    });
    const selectedIds = new Set(
      selected?.revision.content.tradeIds ?? current?.revision.content.tradeIds ?? [],
    );
    const selectedTrades = await Promise.all(
      [...selectedIds].map((id) => ctx.repos.trade.findById(id)),
    );
    const candidateTrades = [
      ...new Map(
        [
          ...eligible,
          ...selectedTrades.flatMap((trade) =>
            trade !== null && trade.accountId === accountId ? [trade] : [],
          ),
        ].map((trade) => [trade.id, trade]),
      ).values(),
    ].sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime() || b.id.localeCompare(a.id));
    const observations = await explicitObservations(ctx, input.subject, stockId);
    return {
      accountId,
      observations,
      observationStatus:
        observations.length > 0 ? ('available' as const) : ('unavailable' as const),
      observationReason: observations.length > 0 ? null : 'no-explicit-observation-source',
      sourceStatus: source === null ? ('unavailable' as const) : ('available' as const),
      context,
      current,
      selected,
      revisions: [...revisions],
      selectedRevision: selected?.revision.revision ?? null,
      validUntil: source === null ? null : source.validUntil,
      stockId,
      sourceOccurredAt: occurredAt,
      ledgerState:
        ledgerState === null ? null : { ...ledgerState, reasons: [...ledgerState.reasons] },
      candidateTrades,
    };
  },
});

export const saveDecisionReviewTool = defineTool({
  name: 'save_decision_review',
  description: '在当前账户保存不可变的决策复盘修订和显式成交关联',
  sideEffect: 'write',
  input: SubjectInput.extend({
    requestId: z.uuid(),
    contextHash: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    content: DecisionReviewContentSchema,
    changeNote: z.string().max(2000).nullable().optional(),
  }).strict(),
  output: z.object({ result: ReviewViewSchema, replayed: z.boolean() }),
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!accountId || (await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const content = { ...input.content, tradeIds: [...new Set(input.content.tradeIds)].sort() };
    const requestHash = digest({
      command: 'save_decision_review',
      accountId,
      subject: input.subject,
      contextHash: input.contextHash,
      expectedRevision: input.expectedRevision,
      content,
      changeNote: input.changeNote ?? null,
    });
    const receipt = await ctx.repos.decisionReview.findWriteReceipt({
      accountId,
      requestId: input.requestId,
    });
    if (receipt !== null) {
      if (receipt.requestHash !== requestHash) return errInvalidInput('请求 ID 已用于其他内容');
      return { result: receipt.result, replayed: true };
    }
    const current = await ctx.repos.decisionReview.findBySubject({
      accountId,
      subject: input.subject,
    });
    const source = current === null ? await resolveSource(ctx, accountId, input.subject) : null;
    if (source === 'denied') return denied();
    if (current === null && source === null)
      return errNotFound('DecisionReviewSource', input.subject.id);
    const context = current?.review.context ?? {
      schemaVersion: 1 as const,
      capturedAt: ctx.clock(),
      sourceDataAsOf: source!.sourceDataAsOf,
      captureOrigin: 'user' as const,
      source: source!.source,
      contextHash: digest({ subject: input.subject, source: source!.source }),
    };
    if (context.contextHash !== input.contextHash)
      return errInvalidInput('来源已变化，请刷新预览后重新确认');
    const occurredAt = current?.review.sourceOccurredAt ?? source!.occurredAt;
    const stockId = current?.review.stockId ?? source!.stockId;
    const tradeFactHashes: Record<string, string> = {};
    for (const id of content.tradeIds) {
      const trade = await ctx.repos.trade.findById(id);
      if (trade === null) return errNotFound('Trade', id);
      if (trade.accountId !== accountId) return denied();
      if (stockId !== null && trade.stockId !== stockId)
        return errInvalidInput('关联成交的股票与原始依据不匹配');
      if (trade.executedAt < occurredAt) return errInvalidInput('成交时间早于原始依据');
      tradeFactHashes[id] = digest(trade);
    }
    const review =
      current === null
        ? {
            id: digest([accountId, input.subject.kind, input.subject.id]),
            accountId,
            subject: input.subject,
            stockId,
            sourceOccurredAt: occurredAt,
            context,
            createdAt: ctx.clock(),
          }
        : current.review;
    const result = await ctx.repos.decisionReview.commit({
      accountId,
      requestId: input.requestId,
      requestHash,
      expectedRevision: input.expectedRevision,
      review,
      content,
      contentHash: digest(content),
      tradeFactHashes,
      changeNote: input.changeNote ?? null,
      recordedAt: ctx.clock(),
    });
    return result;
  },
});

export const listDecisionReviewsTool = defineTool({
  name: 'list_decision_reviews',
  description: '按账户及来源/记录时间分页读取决策复盘；游标固定筛选与修订水位',
  sideEffect: 'read',
  input: z
    .object({
      accountId: z.string().min(1).optional(),
      stockId: z.string().min(1).optional(),
      subjectKind: DecisionReviewSubjectSchema.shape.kind.optional(),
      since: z.coerce.date().optional(),
      until: z.coerce.date().optional(),
      timeBasis: z.enum(['source', 'recorded']).default('source'),
      cursor: z.string().min(1).optional(),
      throughSequence: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict()
    .refine(
      (input) =>
        input.since === undefined || input.until === undefined || input.since <= input.until,
      'until 必须不早于 since',
    ),
  output: z.object({
    accountId: z.string(),
    records: z.array(ReviewViewSchema),
    window: z.object({
      since: z.coerce.date().nullable(),
      until: z.coerce.date().nullable(),
      timeBasis: z.enum(['source', 'recorded']),
    }),
    throughSequence: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().nullable(),
    coverage: z.object({
      status: z.enum(['complete', 'partial']),
      processed: z.number().int().nonnegative(),
      knownTotal: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
    nextCursor: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!accountId || (await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const filterHash = digest({
      accountId,
      stockId: input.stockId,
      subjectKind: input.subjectKind,
      since: input.since?.toISOString(),
      until: input.until?.toISOString(),
      timeBasis: input.timeBasis,
    });
    let cursor: {
      accountId: string;
      filterHash: string;
      throughSequence: number;
      timeBasis: 'source' | 'recorded';
      occurredAt?: string | undefined;
      id?: string | undefined;
      recordedAt?: string | undefined;
      sequence?: number | undefined;
      knownTotal?: number | undefined;
    } | null = null;
    if (input.cursor !== undefined) {
      try {
        cursor = z
          .object({
            accountId: z.string(),
            filterHash: z.string(),
            throughSequence: z.number().int().nonnegative(),
            timeBasis: z.enum(['source', 'recorded']),
            occurredAt: z.iso.datetime().optional(),
            id: z.string().optional(),
            recordedAt: z.iso.datetime().optional(),
            sequence: z.number().int().positive().optional(),
            knownTotal: z.number().int().min(0).max(10001).optional(),
          })
          .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
      } catch {
        return errInvalidInput('复盘游标无效，请重新开始查询');
      }
      if (cursor === null) return errInvalidInput('复盘游标无效');
      if (
        (input.timeBasis === 'source' && (!cursor.occurredAt || !cursor.id)) ||
        (input.timeBasis === 'recorded' && (!cursor.recordedAt || !cursor.sequence))
      )
        return errInvalidInput('复盘游标排序键缺失');
      if (
        cursor.accountId !== accountId ||
        cursor.filterHash !== filterHash ||
        cursor.timeBasis !== input.timeBasis ||
        (input.throughSequence !== undefined && input.throughSequence !== cursor.throughSequence)
      )
        return errInvalidInput('复盘游标与账户、筛选或水位不匹配');
    }
    const throughSequence =
      cursor?.throughSequence ??
      input.throughSequence ??
      (await ctx.repos.decisionReview.latestSequence(accountId));
    const base = {
      accountId,
      ...(input.stockId === undefined ? {} : { stockId: input.stockId }),
      ...(input.subjectKind === undefined ? {} : { subjectKind: input.subjectKind }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
      throughSequence,
    };
    const source = input.timeBasis === 'source';
    // 旧游标没有统计快照时补算一次，后续页沿用同一筛选与修订水位的覆盖率。
    const knownTotal =
      cursor?.knownTotal ??
      (source
        ? await ctx.repos.decisionReview.list({ ...base, limit: 10001 })
        : await ctx.repos.decisionReview.listActivity({ ...base, limit: 10001 })
      ).length;
    const truncated = knownTotal > 10000;
    const page = source
      ? await ctx.repos.decisionReview.list({
          ...base,
          limit: input.limit + 1,
          ...(cursor?.occurredAt !== undefined && cursor.id !== undefined
            ? { cursor: { occurredAt: new Date(cursor.occurredAt), id: cursor.id } }
            : {}),
        })
      : await ctx.repos.decisionReview.listActivity({
          ...base,
          limit: input.limit + 1,
          ...(cursor?.recordedAt !== undefined && cursor.sequence !== undefined
            ? { cursor: { recordedAt: new Date(cursor.recordedAt), sequence: cursor.sequence } }
            : {}),
        });
    const records = page.slice(0, input.limit);
    const last = records.at(-1);
    const nextCursor =
      page.length > input.limit && last !== undefined
        ? Buffer.from(
            JSON.stringify({
              accountId,
              filterHash,
              throughSequence,
              timeBasis: input.timeBasis,
              knownTotal,
              ...(source
                ? { occurredAt: last.review.sourceOccurredAt.toISOString(), id: last.review.id }
                : {
                    recordedAt: last.revision.recordedAt.toISOString(),
                    sequence: last.revision.sequence,
                  }),
            }),
          ).toString('base64url')
        : null;
    return {
      accountId,
      records,
      window: {
        since: input.since ?? null,
        until: input.until ?? null,
        timeBasis: input.timeBasis,
      },
      throughSequence,
      total: truncated ? null : knownTotal,
      coverage: {
        status: truncated ? ('partial' as const) : ('complete' as const),
        processed: Math.min(knownTotal, 10000),
        knownTotal,
        truncated,
      },
      nextCursor,
    };
  },
});

export const getDecisionWriteReceiptTool = defineTool({
  name: 'get_decision_write_receipt',
  description: '按请求 ID 查询已提交复盘回执',
  sideEffect: 'read',
  input: z.object({ accountId: z.string().min(1).optional(), requestId: z.uuid() }).strict(),
  output: z.discriminatedUnion('command', [
    z.object({
      command: z.literal('save_decision_review'),
      requestId: z.string(),
      result: ReviewViewSchema,
    }),
    z.object({
      command: z.literal('record_decision_trade'),
      requestId: z.string(),
      result: DecisionTradeCommitResultSchema,
    }),
  ]),
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!accountId || (await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const receipt = await ctx.repos.decisionReview.findWriteReceipt({
      accountId,
      requestId: input.requestId,
    });
    if (receipt !== null)
      return {
        command: 'save_decision_review' as const,
        requestId: input.requestId,
        result: receipt.result,
      };
    const tradeReceipt = await ctx.repos.decisionTrade.findReceipt({
      accountId,
      requestId: input.requestId,
    });
    if (tradeReceipt !== null)
      return {
        command: 'record_decision_trade' as const,
        requestId: input.requestId,
        result: tradeReceipt.result,
      };
    return errNotFound('DecisionWriteReceipt', input.requestId);
  },
});
