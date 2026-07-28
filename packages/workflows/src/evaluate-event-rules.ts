import {
  type AlertPriority,
  eventImportanceToPriority,
  type StockEvent,
  type StockPool,
  type WatchRule,
  type WatchTrigger,
  type WorkflowRun,
} from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext, type WorkflowStep } from './define-workflow.js';

/**
 * evaluate-event-rules workflow（ruo 迁移 §5，每日盘前，不复用 intraday-watch）。
 *
 *   1. 加载 enabled pool 中所有 event-date 规则（pool × rule）
 *   2. 解析 pool 分组成员
 *   3. listUpcoming(stockId, now, now+max(daysBefore)) 过滤 kinds / minImportance
 *   4. effectiveDays = event.remindBeforeDays 非空 ? 事件级 : 规则 daysBefore
 *      d = event.occursAt − 今日（Asia/Shanghai 自然日差）；d ∈ effectiveDays 且未发过
 *      (poolId, stockId, ruleId, eventId, d) → 生成 WatchTrigger
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
  evaluatedPools: z.number().int().nonnegative(),
  triggered: z.number().int().nonnegative(),
  notified: z.number().int().nonnegative(),
  deduped: z.number().int().nonnegative(),
});

/** 解析 pool 分组成员的 stockId 集合（复用现有读路径）。 */
const resolveMemberStockIds = async (
  pool: StockPool,
  ctx: WorkflowContext,
): Promise<readonly string[]> => {
  const group = await ctx.repos.stockGroup.findById(pool.groupId);
  if (group === null || !group.enabled) return [];
  if (group.resolver.kind === 'manual') return group.resolver.stockIds;
  if (group.resolver.kind === 'holdings') {
    const r = await ctx.tools.list_holdings.execute({ accountId: group.resolver.accountId });
    return r.ok ? r.data.holdings.map((h) => h.holding.stockId) : [];
  }
  // formula / llm → 当前快照
  const members = await ctx.repos.groupMember.currentMembers(group.id);
  return members.map((m) => m.stockId);
};

const eventDateRules = (
  pool: StockPool,
): readonly (Extract<WatchRule, { kind: 'event-date' }> & { id: string })[] =>
  pool.rules
    .filter((r): r is Extract<WatchRule, { kind: 'event-date' }> => r.kind === 'event-date')
    .map((r) => ({ ...r, id: r.id ?? `r_${globalThis.crypto.randomUUID().slice(0, 8)}` }));

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

  const pools = await ctx.repos.stockPool.list(true);
  let evaluatedPools = 0;
  let triggered = 0;
  let deduped = 0;
  const pending: WatchTrigger[] = [];

  try {
    for (const pool of pools) {
      const rules = eventDateRules(pool);
      if (rules.length === 0) continue;
      evaluatedPools += 1;
      const stockIds = await resolveMemberStockIds(pool, ctx);

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

            // 去重：(poolId, stockId, ruleId, eventId, remindDay) 最多一条
            const existing = await ctx.repos.watchTrigger.listRecent({
              poolId: pool.id,
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
              poolId: pool.id,
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
      evaluatedPools,
      triggered,
      notified: 0,
      deduped,
    });
  }

  // 发送 pending（按池分组），回写 deliveryStatus
  let notified = 0;
  let sendFailed = false;
  const byPool = new Map<string, WatchTrigger[]>();
  for (const t of pending) {
    const arr = byPool.get(t.poolId) ?? [];
    arr.push(t);
    byPool.set(t.poolId, arr);
  }
  for (const [poolId, group] of byPool) {
    const lines = group.map((t) => {
      const prio =
        t.priority === 'urgent' ? '【急】' : t.priority === 'important' ? '【重要】' : '';
      return `· ${prio}${t.stockId} — ${t.reason}`;
    });
    const r = await ctx.tools.send_notification.execute({
      log: {
        title: `事件提醒 池-${poolId} ${group.length} 条`,
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
    outputSummary: { evaluatedPools, triggered, notified, deduped },
  };
  await ctx.repos.workflowRun.save(terminal);

  return EvaluateEventRulesOutput.parse({
    runId,
    status,
    evaluatedPools,
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
