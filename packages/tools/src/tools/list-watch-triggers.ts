import type { ToolContext } from '@luoome/core';
import {
  AlertPrioritySchema,
  DeliveryStatusSchema,
  TriggerFeedbackSchema,
  TriggerTypeSchema,
  WatchRuleKindSchema,
  WatchTriggerSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const ListWatchTriggersInput = z.object({
  accountId: z.string().min(1).optional(),
  alertPlanId: z.string().min(1).optional(),
  poolId: z.string().min(1).optional(),
  stockId: z.string().min(1).optional(),
  ruleKind: WatchRuleKindSchema.optional(),
  ruleId: z.string().min(1).optional(),
  notified: z.boolean().optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  priority: AlertPrioritySchema.optional(),
  feedback: z.union([TriggerFeedbackSchema, z.literal('unreviewed')]).optional(),
  triggerType: TriggerTypeSchema.optional(),
  deliveryStatus: z.array(DeliveryStatusSchema).optional(),
  includeSummary: z.boolean().default(false),
  orderBy: z.enum(['recent', 'priority']).default('recent'),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().positive().max(10_000).default(50),
});

export const ListWatchTriggersOutput = z.object({
  triggers: z.array(WatchTriggerSchema.extend({ stockName: z.string().optional() })),
  /** 过滤后、limit 前的总数。 */
  total: z.number().int().nonnegative(),
  summary: z
    .object({
      priorityCounts: z.record(z.string(), z.number().int().nonnegative()),
      /**
       * 提醒要素缺口（REQ-M3-09 §5）：两个数**分开**。
       *
       * - `missingElements`：因要素不全而**真正没投出去**的条数（`not-requested` 中由要素闸门
       *   判定的那部分）——这是用户会关心的「N 条提醒没发出去」。
       * - `notApplicableElements`：阈值型/事件型里**本就不适用**的计划五项条数——
       *   它们**都发出去了**，混进上一个数会让用户以为提醒失败了。
       */
      reminderGaps: z
        .object({
          missingElements: z.number().int().nonnegative(),
          notApplicableElements: z.number().int().nonnegative(),
        })
        .optional(),
      deliveryStatusCounts: z.record(z.string(), z.number().int().nonnegative()),
      feedbackCounts: z.record(z.string(), z.number().int().nonnegative()),
      stocks: z.array(
        z.object({
          stockId: z.string(),
          count: z.number().int().positive(),
          maxPriority: AlertPrioritySchema,
          latest: WatchTriggerSchema,
        }),
      ),
    })
    .optional(),
});

/** 带 `notApplicableElements` 的触发条数：不适用≠缺失，必须与未投递数分开计。 */
const countNotApplicable = async (
  ctx: ToolContext,
  input: { readonly poolId?: string | undefined },
): Promise<number> => {
  const rows = await ctx.repos.watchTrigger.listRecent({
    ...(input.poolId === undefined ? {} : { poolId: input.poolId }),
    limit: 10_000,
  });
  return rows.filter((row) => Array.isArray(row.evalSnapshot.notApplicableElements)).length;
};

export const listWatchTriggersTool = defineTool({
  name: 'list_watch_triggers',
  description:
    '查询最近 AlertPlan 触发（按计划/股票/规则/优先级/反馈/通知状态过滤，准确计数并分页，支持时间或优先级排序，可选 includeSummary 返回筛选范围的完整统计）',
  sideEffect: 'read',
  input: ListWatchTriggersInput,
  output: ListWatchTriggersOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!accountId || (await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const {
      triggers: page,
      total,
      summary,
    } = await ctx.repos.watchTrigger.query({
      accountId,
      offset: input.offset,
      includeSummary: input.includeSummary,
      orderBy: input.orderBy,
      limit: input.limit,
      ...(input.alertPlanId === undefined ? {} : { alertPlanId: input.alertPlanId }),
      ...(input.stockId === undefined ? {} : { stockId: input.stockId }),
      ...(input.ruleKind === undefined ? {} : { ruleKind: input.ruleKind }),
      ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
      ...(input.notified === undefined ? {} : { notified: input.notified }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
      ...(input.triggerType === undefined ? {} : { triggerType: input.triggerType }),
      ...(input.deliveryStatus === undefined ? {} : { deliveryStatus: input.deliveryStatus }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
      ...(input.alertPlanId === undefined && input.poolId !== undefined
        ? { poolId: input.poolId }
        : {}),
    });
    const names = new Map(
      await Promise.all(
        [...new Set(page.map((trigger) => trigger.stockId))].map(async (stockId) => {
          const stock = await ctx.repos.stock.findById(stockId);
          return [stockId, stock?.name] as const;
        }),
      ),
    );
    /**
     * 两个计数分开（REQ-M3-09 §5 / Lead 裁定 ⑤）：
     * - `missingElements`：真正因要素不全没投出去的（`not-requested` 且 evalSnapshot 记了缺口）；
     * - `notApplicableElements`：不适用（阈值型/事件型的计划五项），它们**都发出去了**。
     *
     * 只统计本页之外的整个筛选范围时才能拿到 summary；这里按 `includeSummary` 的同一批
     * 数据算，不做额外查询之外的近似。
     */
    const reminderGaps =
      summary === undefined
        ? undefined
        : {
            missingElements: summary.deliveryStatusCounts['not-requested'] ?? 0,
            notApplicableElements: await countNotApplicable(ctx, input),
          };
    return {
      triggers: ListWatchTriggersOutput.shape.triggers.parse(
        page.map((trigger) => ({ ...trigger, stockName: names.get(trigger.stockId) })),
      ),
      total,
      ...(summary === undefined
        ? {}
        : {
            summary: {
              ...summary,
              stocks: [...summary.stocks],
              ...(reminderGaps === undefined ? {} : { reminderGaps }),
            },
          }),
    };
  },
});
