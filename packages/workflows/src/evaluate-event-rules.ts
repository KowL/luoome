import {
  type AlertPlan,
  type AlertPriority,
  type AlertRule,
  eventImportanceToPriority,
  type StockEvent,
  type WatchTrigger,
  type WorkflowRun,
} from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext, type WorkflowStep } from './define-workflow.js';

/**
 * evaluate-event-rules workflow（ruo 迁移 §5，每日盘前，不复用 intraday-watch）。
 *
 *   1. 加载 enabled AlertPlan 中所有 event-date 规则
 *   2. 解析其 Watchlist 当前成员
 *   3. listUpcoming(stockId, now, now+max(daysBefore)) 过滤 kinds / minImportance
 *   4. effectiveDays = event.remindBeforeDays 非空 ? 事件级 : 规则 daysBefore
 *      d = event.occursAt − 今日（Asia/Shanghai 自然日差）；d ∈ effectiveDays 且未发过
 *      (alertPlanId, stockId, ruleId, eventId, d) → 生成 WatchTrigger
 *   5. 送达矩阵：normal → not-requested（仅记录）；important/urgent → pending → 发送
 *
 * 用法：`luoome workflow run evaluate-event-rules`（cron 每交易日 08:50，同步之后）。
 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Asia/Shanghai 当日 00:00 的 UTC 毫秒。 */
const shanghaiMidnightMs = (date: Date): number => {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted.getTime() - SHANGHAI_OFFSET_MS;
};

/** 自然日差（Asia/Shanghai）：event 日 − 今日。 */
const dayDiff = (eventAt: Date, now: Date): number =>
  Math.round((shanghaiMidnightMs(eventAt) - shanghaiMidnightMs(now)) / DAY_MS);

export const EvaluateEventRulesInput = z.object({
  mode: z.enum(['manual', 'scheduled', 'daemon']).default('scheduled'),
  /** true 时不发送通知，仅落库（试跑）。 */
  dryRun: z.boolean().default(false),
});

export type EvaluateEventRulesInputT = z.infer<typeof EvaluateEventRulesInput>;

export const EvaluateEventRulesOutput = z.object({
  runId: z.string(),
  status: z.enum(['succeeded', 'partial', 'failed']),
  evaluatedPlans: z.number().int().nonnegative(),
  triggered: z.number().int().nonnegative(),
  notified: z.number().int().nonnegative(),
  deduped: z.number().int().nonnegative(),
});

/** 解析 AlertPlan 所属 Watchlist 的当前成员。 */
const resolveMemberStockIds = async (
  plan: AlertPlan,
  ctx: WorkflowContext,
): Promise<readonly string[]> => {
  const watchlist = await ctx.repos.watchlist.findById(plan.watchlistId);
  if (watchlist === null || !watchlist.enabled) return [];
  const members = await ctx.repos.watchlistMember.listMembers(watchlist.id);
  return members.map((m) => m.stockId);
};

const eventDateRules = (plan: AlertPlan): readonly Extract<AlertRule, { kind: 'event-date' }>[] =>
  plan.rules.filter(
    (rule): rule is Extract<AlertRule, { kind: 'event-date' }> => rule.kind === 'event-date',
  );

const buildReason = (event: StockEvent, d: number): string => {
  const when = d === 0 ? '今日' : `${d} 天后`;
  return `${event.title}（${when}，${event.kind}）`;
};

const buildEvidence = (event: StockEvent): string[] => {
  const ev: string[] = [];
  if (event.provider !== undefined) ev.push(`来源: ${event.provider}`);
  if (event.sourceUrl !== undefined) ev.push(event.sourceUrl);
  ev.push(`发生时间: ${event.occursAt.toISOString().slice(0, 10)}`);
  if (event.stale) ev.push('数据可能过期');
  return ev;
};

const stepEvaluate: WorkflowStep = async (prev, ctx: WorkflowContext) => {
  const input = prev as EvaluateEventRulesInputT;
  const now = ctx.clock();
  const runId = `wfr_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const runningRun: WorkflowRun = {
    id: runId,
    workflowName: 'evaluate-event-rules',
    mode: input.mode,
    status: 'running',
    startedAt: now,
    providerStatuses: [],
  };
  await ctx.repos.workflowRun.save(runningRun);

  const plans = await ctx.repos.alertPlan.list({ enabledOnly: true });
  let evaluatedPlans = 0;
  let triggered = 0;
  let deduped = 0;
  const pending: WatchTrigger[] = [];

  try {
    for (const plan of plans) {
      const rules = eventDateRules(plan);
      if (rules.length === 0) continue;
      evaluatedPlans += 1;
      const stockIds = await resolveMemberStockIds(plan, ctx);

      for (const rule of rules) {
        const maxDays = Math.max(0, ...(rule.daysBefore.length > 0 ? rule.daysBefore : [7, 3, 1]));
        const windowEnd = new Date(shanghaiMidnightMs(now) + (maxDays + 1) * DAY_MS);
        for (const stockId of stockIds) {
          const events = await ctx.repos.stockEvent.listUpcoming(stockId, now, windowEnd, {
            ...(rule.eventKinds !== undefined ? { kinds: rule.eventKinds } : {}),
            minImportance: rule.minImportance,
          });
          for (const event of events) {
            const effectiveDays =
              event.remindBeforeDays.length > 0 ? event.remindBeforeDays : rule.daysBefore;
            const d = dayDiff(event.occursAt, now);
            if (!effectiveDays.includes(d)) continue;

            // 去重：(alertPlanId, stockId, ruleId, eventId, remindDay) 最多一条
            const existing = await ctx.repos.watchTrigger.listRecent({
              poolId: plan.id,
              ruleId: rule.id,
              eventId: event.id,
              limit: 100,
            });
            const already = existing.some(
              (t) => (t.evalSnapshot as { remindDay?: number }).remindDay === d,
            );
            if (already) {
              deduped += 1;
              continue;
            }

            const priority: AlertPriority =
              rule.priority ?? eventImportanceToPriority(event.importance);
            const deliveryStatus =
              input.dryRun || priority === 'normal' ? 'not-requested' : 'pending';

            const trigger: WatchTrigger = {
              id: `wt_${globalThis.crypto.randomUUID().slice(0, 8)}`,
              alertPlanId: plan.id,
              poolId: plan.id,
              stockId,
              ruleKind: 'event-date',
              ruleId: rule.id,
              eventId: event.id,
              direction: 'watch',
              triggerType: 'triggered',
              reason: buildReason(event, d),
              evidence: buildEvidence(event),
              priority,
              deliveryStatus,
              evalSnapshot: {
                eventId: event.id,
                eventKind: event.kind,
                remindDay: d,
                importance: event.importance,
                stale: event.stale,
                occursAt: event.occursAt.toISOString(),
              },
              notified: false,
              createdAt: now,
            };
            await ctx.repos.watchTrigger.save(trigger);
            triggered += 1;
            if (deliveryStatus === 'pending') pending.push(trigger);
          }
        }
      }
    }
  } catch (error) {
    const failed: WorkflowRun = {
      ...runningRun,
      status: 'failed',
      finishedAt: ctx.clock(),
      error: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
    };
    await ctx.repos.workflowRun.save(failed);
    return EvaluateEventRulesOutput.parse({
      runId,
      status: 'failed',
      evaluatedPlans,
      triggered,
      notified: 0,
      deduped,
    });
  }

  // 发送 pending（按 AlertPlan 分组），回写 deliveryStatus
  let notified = 0;
  let sendFailed = false;
  const byPlan = new Map<string, WatchTrigger[]>();
  for (const t of pending) {
    const arr = byPlan.get(t.poolId) ?? [];
    arr.push(t);
    byPlan.set(t.poolId, arr);
  }
  for (const [alertPlanId, group] of byPlan) {
    const lines = group.map((t) => {
      const prio =
        t.priority === 'urgent' ? '【急】' : t.priority === 'important' ? '【重要】' : '';
      return `· ${prio}${t.stockId} — ${t.reason}`;
    });
    const r = await ctx.tools.send_notification.execute({
      log: {
        title: `事件提醒 ${alertPlanId} ${group.length} 条`,
        content: lines.join('\n'),
        level: 'info',
      },
    });
    let status: WatchTrigger['deliveryStatus'] = 'sent';
    let notificationId: string | undefined;
    if (!r.ok) {
      status = 'failed';
      sendFailed = true;
    } else if (r.data.notification.result === 'suppressed') {
      status = 'fallback-log';
      notificationId = r.data.notification.id;
    } else if (r.data.notification.result === 'failed') {
      status = 'failed';
      sendFailed = true;
    } else {
      notificationId = r.data.notification.id;
      notified += group.length;
    }
    await ctx.repos.watchTrigger.setDeliveryStatus(
      group.map((t) => t.id),
      status,
      notificationId,
    );
  }

  const status: WorkflowRun['status'] = sendFailed ? 'partial' : 'succeeded';
  const terminal: WorkflowRun = {
    ...runningRun,
    status,
    finishedAt: ctx.clock(),
    outputSummary: { evaluatedPlans, triggered, notified, deduped },
  };
  await ctx.repos.workflowRun.save(terminal);

  return EvaluateEventRulesOutput.parse({
    runId,
    status,
    evaluatedPlans,
    triggered,
    notified,
    deduped,
  });
};

export const evaluateEventRulesWorkflow = defineWorkflow<
  z.infer<typeof EvaluateEventRulesInput>,
  z.infer<typeof EvaluateEventRulesOutput>
>({
  name: 'evaluate-event-rules',
  description: '每日盘前求值 event-date 规则，落 WatchTrigger 并按送达矩阵发送',
  input: EvaluateEventRulesInput,
  steps: [stepEvaluate],
});
