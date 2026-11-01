import { AlertPlanSchema, type WatchTrigger, WatchTriggerSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

/**
 * 按 `triggerId` 核对一条历史提醒（task-39 批次 C / PRD M4-01 的「通知目标」降级版）。
 *
 * ## 为什么输出只有这么点
 *
 * 旧版 `apps/web` 的 `/api/watch/notifications/:triggerId` 返回
 * `{ state, changes, trigger, sourcePlan, latestVersion, checkedAt }`，
 * 其中 `state`（`requires-recheck` / `changed` / `unavailable`）依赖
 * 「原触发条件 + 当前行情 + 账户状态」三方对比——**那是策略级判定**，
 * 其实现随旧服务端一起移除，**没有可还原的来源**。
 *
 * 所以这里**只给真正拿得到的两样东西**：
 * 1. `trigger`：`WatchTrigger` 直出；
 * 2. `alertPlan`：按 `trigger.alertPlanId` 查到的告警计划（名称 + 规则摘要）。
 *
 * **刻意不提供 `state` / `changes` / `sourcePlan` / `latestVersion`，连 `null` 字段都不给**——
 * 给了 `null`，调用方就会写 `state === null ? '未知' : state`，等于给了一个**看似可用的形状**，
 * 用户会以为「系统核对过、结论是还成立」。**那是伪装，不是降级。**
 *
 * 三处原因由 `unavailableReason` 显式给出，UI 必须原样展示（见 `alerts.js`）。
 */
export const RESOLVE_WATCH_NOTIFICATION_UNAVAILABLE_REASON =
  'historical-verification-not-migrated' as const;

/** `alertPlan` 为什么没给（三种，都必须有明确原因，不许静默返回空）。 */
export const ALERT_PLAN_LOOKUP_REASONS = [
  /** 这条 trigger 本身没有 `alertPlanId`（实体上它是 `.optional()`）。 */
  'trigger-without-alert-plan',
  /** 有 id，但计划已被删除或不在当前可见范围。 */
  'alert-plan-not-found',
] as const;

export const ResolveWatchNotificationInput = z.object({ triggerId: z.string().min(1) }).strict();

/** 规则摘要：只给「够认出是哪条规则」的最小信息，不复述整个规则对象。 */
export const AlertRuleSummarySchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    priority: z.string().optional(),
    /** 一行可读描述（如「价格上穿 100」），没有就缺省。 */
    text: z.string().optional(),
  })
  .strict();

export const ResolveWatchNotificationOutput = z
  .object({
    trigger: WatchTriggerSchema,
    /** 告警计划摘要；查不到时缺席（**不是 null**），原因见 `alertPlanReason`。 */
    alertPlan: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        enabled: z.boolean(),
        watchlistId: z.string().min(1),
        rules: z.array(AlertRuleSummarySchema),
      })
      .strict()
      .optional(),
    /** 与 `alertPlan` 配对出现：为什么没给。 */
    alertPlanReason: z.enum(ALERT_PLAN_LOOKUP_REASONS).optional(),
    /**
     * 历史核对能力不可用的原因（**恒出现**）：这条不是「没做」，是数据模型里没有这条边。
     */
    unavailableReason: z.literal(RESOLVE_WATCH_NOTIFICATION_UNAVAILABLE_REASON),
    checkedAt: z.coerce.date(),
  })
  .strict();

export type ResolveWatchNotificationOutputValue = z.output<typeof ResolveWatchNotificationOutput>;

/** 规则 → 一行摘要（`price-level` 等各自最关键的数值）。 */
const ruleSummary = (raw: unknown): z.infer<typeof AlertRuleSummarySchema> => {
  const rule = raw as {
    id: string;
    kind: string;
    priority?: string;
    level?: number;
    side?: string;
    pct?: number;
    metric?: string;
    comparator?: string;
    value?: number;
  };
  const text =
    rule.level !== undefined && rule.side !== undefined
      ? `价格 ${rule.side === 'above' ? '上穿' : '下破'} ${String(rule.level)}`
      : rule.pct !== undefined
        ? `成本 ${String(Math.round(rule.pct * 1000) / 10)}%`
        : undefined;
  return {
    id: rule.id,
    kind: rule.kind,
    ...(rule.priority === undefined ? {} : { priority: rule.priority }),
    ...(text === undefined ? {} : { text }),
  };
};

export const resolveWatchNotificationTool = defineTool({
  name: 'resolve_watch_notification',
  description:
    '按 triggerId 核对一条历史提醒：返回触发当时的记录与它所属的告警计划（名称 + 规则摘要）。**不判断「现在是否仍成立」**——该能力未迁移，原因随输出返回。',
  sideEffect: 'read',
  input: ResolveWatchNotificationInput,
  output: ResolveWatchNotificationOutput,
  handler: async (input, ctx) => {
    const trigger: WatchTrigger | null = await ctx.repos.watchTrigger.findById(input.triggerId);
    if (trigger === null) return errNotFound('WatchTrigger', input.triggerId);

    const checkedAt = ctx.clock();
    const alertPlanId = trigger.alertPlanId;
    if (alertPlanId === undefined)
      return {
        trigger,
        alertPlanReason: ALERT_PLAN_LOOKUP_REASONS[0],
        unavailableReason: RESOLVE_WATCH_NOTIFICATION_UNAVAILABLE_REASON,
        checkedAt,
      };

    const plan = await ctx.repos.alertPlan.findById(alertPlanId);
    if (plan === null)
      return {
        trigger,
        alertPlanReason: ALERT_PLAN_LOOKUP_REASONS[1],
        unavailableReason: RESOLVE_WATCH_NOTIFICATION_UNAVAILABLE_REASON,
        checkedAt,
      };

    const parsed = AlertPlanSchema.parse(plan);
    return {
      trigger,
      alertPlan: {
        id: parsed.id,
        name: parsed.name,
        enabled: parsed.enabled,
        watchlistId: parsed.watchlistId,
        rules: parsed.rules.map((rule) => ruleSummary(rule)),
      },
      unavailableReason: RESOLVE_WATCH_NOTIFICATION_UNAVAILABLE_REASON,
      checkedAt,
    };
  },
});
