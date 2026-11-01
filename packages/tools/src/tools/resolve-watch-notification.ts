import {
  AlertPlanSchema,
  tradingPlanVersionId,
  type WatchTrigger,
  WatchTriggerSchema,
  watchTriggerPlanSource,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

/**
 * 按 `triggerId` 核对一条历史提醒（task-39 批次 C / PRD M4-01 的「通知目标」）。
 *
 * ## 为什么输出只有这么点
 *
 * 旧版 `apps/web` 的 `/api/watch/notifications/:triggerId` 返回
 * `{ state, changes, trigger, sourcePlan, latestVersion, checkedAt }`，
 * 其中 `state`（`requires-recheck` / `changed` / `unavailable`）依赖
 * 「原触发条件 + 当前行情 + 账户状态」三方对比——**那是策略级判定**。
 * 它并非「随旧服务端一起移除」（那份实现在 `@luoome/tools/personal` 的
 * `resolve_hosted_watch_notification`，见 task-40 报告），但它把「不可变快照」
 * 与「随时点变的监控资格」混在同一份输出里，**本工具只给前者**。
 *
 * 所以这里**只给真正拿得到的东西**：
 * 1. `trigger`：`WatchTrigger` 直出；
 * 2. `alertPlan`：**watchlist 规则触发**所属的告警计划（名称 + 规则摘要）；
 * 3. `sourcePlan`：**交易计划触发**所依据的**计划版本**（`versionId` 是 `<planId>:v<version>`）。
 *
 * 第 2 与第 3 条是互斥的两条来源链。判断哪一条走 `watchTriggerPlanSource`
 * （core 唯一实现），**不要在这里再写一次 `poolId.startsWith(...)`**：
 * `trigger.alertPlanId` 历史上对计划类触发装的是 poolId 而不是 `AlertPlan.id`
 * （task-40 §1.4），直接拿它 `findById` 必然 not-found——那正是批次 C 的实质缺陷。
 *
 * **仍然刻意不提供 `state` / `changes` / `latestVersion`，连 `null` 字段都不给**——
 * 给了 `null`，调用方就会写 `state === null ? '未知' : state`，等于给了一个**看似可用的形状**，
 * 用户会以为「系统核对过、结论是还成立」。**那是伪装，不是降级。**
 *
 * 原因由 `unavailableReason` 与 `sourcePlanReason` / `alertPlanReason` 显式给出，UI 必须原样展示。
 */
export const RESOLVE_WATCH_NOTIFICATION_UNAVAILABLE_REASON =
  'historical-verification-not-migrated' as const;

/** `alertPlan` 为什么没给（都必须有明确原因，不许静默返回空）。 */
export const ALERT_PLAN_LOOKUP_REASONS = [
  /** 这条 trigger 本身没有任何计划来源（既非 watchlist 规则也非计划条件）。 */
  'trigger-without-alert-plan',
  /** 有 id，但计划已被删除或不在当前可见范围。 */
  'alert-plan-not-found',
  /** 这条 trigger 来自**交易计划**条件，不是 watchlist 规则——来源在 `sourcePlan` 里。 */
  'trigger-from-trading-plan',
] as const;

/** `sourcePlan` 为什么没给。 */
export const SOURCE_PLAN_LOOKUP_REASONS = [
  /** 计划版本已被删除（`TradingPlan.remove`），不可变依据随之消失。 */
  'plan-version-not-found',
  /** 计划版本的账户/股票与这条提醒不一致——数据不一致，不是「计划变了」。 */
  'plan-mismatch',
  /** 计划类触发但 `evalSnapshot` 不自洽（旧行/手工构造），无法定位版本。 */
  'plan-version-unresolvable',
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
     * 交易计划触发所依据的**那一版计划**（`versionId` = `<planId>:v<version>`）。
     * 计划版本不可变，所以它就是「提醒发出时的原始依据」；查不到时缺席，原因见 `sourcePlanReason`。
     */
    sourcePlan: z
      .object({
        planId: z.string().min(1),
        versionId: z.string().min(1),
        version: z.number().int().positive(),
        stockId: z.string().min(1),
        status: z.string().min(1),
        accountFactsDigest: z.string().min(1),
        validFrom: z.coerce.date(),
        validUntil: z.coerce.date(),
        createdAt: z.coerce.date(),
      })
      .strict()
      .optional(),
    /** 与 `sourcePlan` 配对出现：为什么没给。 */
    sourcePlanReason: z.enum(SOURCE_PLAN_LOOKUP_REASONS).optional(),
    /** 这条提醒的计划来源属于哪条链（core `watchTriggerPlanSource` 的判定结果）。 */
    planSourceKind: z.enum(['alert-plan', 'trading-plan-watch', 'unknown']),
    /**
     * 历史核对能力不可用的原因（**恒出现**）：本轮只给不可变快照，不给随时点变的监控资格。
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
    '按 triggerId 核对一条历史提醒：返回触发当时的记录，以及它的计划来源——watchlist 规则触发给出所属告警计划，交易计划触发给出所依据的计划版本。**不判断「现在是否仍成立」**，原因随输出返回。',
  sideEffect: 'read',
  input: ResolveWatchNotificationInput,
  output: ResolveWatchNotificationOutput,
  handler: async (input, ctx) => {
    const trigger: WatchTrigger | null = await ctx.repos.watchTrigger.findById(input.triggerId);
    if (trigger === null) return errNotFound('WatchTrigger', input.triggerId);

    const checkedAt = ctx.clock();
    const source = watchTriggerPlanSource(trigger);
    const base = {
      trigger,
      planSourceKind: source.kind,
      unavailableReason: RESOLVE_WATCH_NOTIFICATION_UNAVAILABLE_REASON,
      checkedAt,
    } as const;

    // 交易计划条件触发：依据是那一版计划，与 AlertPlan 无关。
    if (source.kind === 'trading-plan-watch') {
      if (source.versionId === undefined)
        return { ...base, sourcePlanReason: SOURCE_PLAN_LOOKUP_REASONS[2] };
      const plan = await ctx.repos.tradingPlan.findByVersionId(source.versionId);
      if (plan === null) return { ...base, sourcePlanReason: SOURCE_PLAN_LOOKUP_REASONS[0] };
      if (plan.accountId !== source.accountId || plan.stockId !== trigger.stockId)
        return { ...base, sourcePlanReason: SOURCE_PLAN_LOOKUP_REASONS[1] };
      return {
        ...base,
        sourcePlan: {
          planId: plan.id,
          versionId: tradingPlanVersionId(plan),
          version: plan.version,
          stockId: plan.stockId,
          status: plan.status,
          accountFactsDigest: plan.accountFactsDigest,
          validFrom: plan.validFrom,
          validUntil: plan.validUntil,
          createdAt: plan.createdAt,
        },
      };
    }

    if (source.kind === 'unknown')
      return { ...base, alertPlanReason: ALERT_PLAN_LOOKUP_REASONS[0] };

    const plan = await ctx.repos.alertPlan.findById(source.alertPlanId);
    if (plan === null) return { ...base, alertPlanReason: ALERT_PLAN_LOOKUP_REASONS[1] };

    const parsed = AlertPlanSchema.parse(plan);
    return {
      ...base,
      alertPlan: {
        id: parsed.id,
        name: parsed.name,
        enabled: parsed.enabled,
        watchlistId: parsed.watchlistId,
        rules: parsed.rules.map((rule) => ruleSummary(rule)),
      },
    };
  },
});
