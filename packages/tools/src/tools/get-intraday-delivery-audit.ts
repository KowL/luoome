import { DeliveryStatusSchema, dateInShanghai } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

const MAX_ACTION_LATENCY_MS = 10 * 60_000;
const SHANGHAI_DAY_MS = 24 * 60 * 60_000;

export const GetIntradayDeliveryAuditInput = z.object({
  accountId: z.string().min(1).optional(),
  date: z.string().date().optional(),
});

export const GetIntradayDeliveryAuditOutput = z.object({
  accountId: z.string(),
  date: z.string().date(),
  candidateCount: z.number().int().nonnegative(),
  deliveryStatusCounts: z.record(z.string(), z.number().int().nonnegative()),
  sourceEventTimeUnverifiable: z.number().int().nonnegative(),
  channelAcceptance: z.object({
    accepted: z.number().int().nonnegative(),
    withinTenMinutes: z.number().int().nonnegative(),
    overTenMinutes: z.number().int().nonnegative(),
    timingUnverifiable: z.number().int().nonnegative(),
    notAccepted: z.number().int().nonnegative(),
    p50Ms: z.number().int().nonnegative().nullable(),
    p95Ms: z.number().int().nonnegative().nullable(),
    maxMs: z.number().int().nonnegative().nullable(),
  }),
  deviceDeliveryVerified: z.literal(false),
});

const sourceEventAt = (snapshot: Record<string, unknown>, detectedAt: Date): Date | null => {
  const raw = snapshot.firstEventAt ?? snapshot.quoteObservedAt;
  if (!(raw instanceof Date) && typeof raw !== 'string') return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() > detectedAt.getTime()) return null;
  return parsed;
};

const percentile = (sorted: readonly number[], p: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.ceil(sorted.length * p) - 1] ?? null);

export const getIntradayDeliveryAuditTool = defineTool({
  name: 'get_intraday_delivery_audit',
  description:
    '按账户和上海自然日汇总全部盘中行动候选的渠道时效；超时、失败、抑制与不可核验分别计数，设备送达保持未验证',
  sideEffect: 'read',
  input: GetIntradayDeliveryAuditInput,
  output: GetIntradayDeliveryAuditOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const date = input.date ?? dateInShanghai(ctx.clock());
    const since = new Date(`${date}T00:00:00+08:00`);
    const until = new Date(since.getTime() + SHANGHAI_DAY_MS - 1);
    const { triggers } = await ctx.repos.watchTrigger.query({
      poolId: `trading-plan-watch:${accountId}`,
      since,
      until,
      offset: 0,
      limit: Number.MAX_SAFE_INTEGER,
    });

    const deliveryStatusCounts: Record<string, number> = Object.fromEntries(
      DeliveryStatusSchema.options.map((status) => [status, 0]),
    );
    const acceptedLatencies: number[] = [];
    let sourceEventTimeUnverifiable = 0;
    let timingUnverifiable = 0;
    for (const trigger of triggers) {
      deliveryStatusCounts[trigger.deliveryStatus] =
        (deliveryStatusCounts[trigger.deliveryStatus] ?? 0) + 1;
      const eventAt = sourceEventAt(trigger.evalSnapshot, trigger.createdAt);
      if (eventAt === null) sourceEventTimeUnverifiable += 1;
      if (trigger.deliveryStatus !== 'sent') continue;
      const acceptedAt = trigger.deliveryCompletedAt;
      const latencyMs =
        eventAt === null || acceptedAt === undefined
          ? null
          : acceptedAt.getTime() - eventAt.getTime();
      if (latencyMs === null || latencyMs < 0) {
        timingUnverifiable += 1;
      } else {
        acceptedLatencies.push(latencyMs);
      }
    }
    acceptedLatencies.sort((a, b) => a - b);
    const accepted = deliveryStatusCounts.sent ?? 0;
    const withinTenMinutes = acceptedLatencies.filter(
      (latency) => latency <= MAX_ACTION_LATENCY_MS,
    ).length;
    return {
      accountId,
      date,
      candidateCount: triggers.length,
      deliveryStatusCounts,
      sourceEventTimeUnverifiable,
      channelAcceptance: {
        accepted,
        withinTenMinutes,
        overTenMinutes: acceptedLatencies.length - withinTenMinutes,
        timingUnverifiable,
        notAccepted: triggers.length - accepted,
        p50Ms: percentile(acceptedLatencies, 0.5),
        p95Ms: percentile(acceptedLatencies, 0.95),
        maxMs: acceptedLatencies.at(-1) ?? null,
      },
      deviceDeliveryVerified: false as const,
    };
  },
});
