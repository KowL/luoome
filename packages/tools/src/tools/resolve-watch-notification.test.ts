import { type WatchTrigger, WatchTriggerSchema } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  RESOLVE_WATCH_NOTIFICATION_UNAVAILABLE_REASON,
  resolveWatchNotificationTool,
} from './resolve-watch-notification.js';

const NOW = new Date('2026-08-01T00:00:00.000Z');

/**
 * 用 `WatchTriggerSchema.parse` 造完整触发记录（**不手写对象**）：
 * 手写会漏 `poolId` / `deliveryStatus` / `stockName` 等必填字段，
 * 而这些正是输出 schema 校验会抓的。
 */
const trigger = (overrides: Record<string, unknown> = {}): WatchTrigger =>
  WatchTriggerSchema.parse({
    id: 'tr-1',
    poolId: 'plan-1',
    stockId: '600519.SH',
    stockName: '贵州茅台',
    ruleId: 'rule-1',
    ruleKind: 'price-level',
    direction: 'watch',
    triggerType: 'triggered',
    reason: '价格上穿 100',
    evidence: ['价格 100.00 上穿阈值 100'],
    priority: 'normal',
    deliveryStatus: 'not-requested',
    // 评估细节包：schema 要求至少含 `ruleId`（`watch-trigger.ts:229` 的注释）。
    evalSnapshot: { ruleId: 'rule-1' },
    createdAt: NOW,
    notified: false,
    ...overrides,
  });

const plan = (overrides: Record<string, unknown> = {}) => ({
  id: 'plan-1',
  name: '默认规则',
  watchlistId: 'wl-1',
  rules: [{ id: 'rule-1', kind: 'price-level' as const, level: 100, side: 'above' as const }],
  logic: 'ANY' as const,
  triggerMode: 'on-enter' as const,
  cooldownMinutes: 30,
  dailyNotificationLimit: 10,
  notifyOnRecovery: false,
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('task-39 resolve_watch_notification（B1 降级版）', () => {
  it('① 有 alertPlanId 且查得到 → 给出计划名称与规则摘要', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.watchTrigger.save(trigger({ alertPlanId: 'plan-1' }));
    await ctx.repos.alertPlan.save(plan() as never);

    const result = await resolveWatchNotificationTool.execute({ triggerId: 'tr-1' }, ctx);
    if (!result.ok) throw new Error(`failed: ${JSON.stringify(result.error)}`);
    expect(result.data.trigger.id).toBe('tr-1');
    expect(result.data.alertPlan?.name).toBe('默认规则');
    expect(result.data.alertPlan?.rules[0]?.text).toBe('价格 上穿 100');
    expect(result.data.alertPlanReason).toBeUndefined();
  });

  it('② alertPlanId 为空 → 缺席 + 明确原因（不静默返回空）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    // 仓储在 `alertPlanId` 缺省时会用 `poolId` 回填（与 drizzle 写入语义一致），
    // 所以「真的没有告警计划」必须构造一个 **poolId 也不指向任何计划** 的触发记录。
    await ctx.repos.watchTrigger.save(trigger({ poolId: 'pool-orphan' }));
    // 前提确认：仓储确实回填了 alertPlanId，且它指向一个不存在的计划。
    const stored = await ctx.repos.watchTrigger.findById('tr-1');
    expect(stored?.alertPlanId).toBe('pool-orphan');

    const result = await resolveWatchNotificationTool.execute({ triggerId: 'tr-1' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.alertPlan).toBeUndefined();
    // 回填后指向不存在的计划 ⇒ 原因落在 `alert-plan-not-found`。
    // 这正是**实体层的真实行为**：`alertPlanId` 是 `.optional()`，但仓储会回填 `poolId`，
    // 所以「没有计划」在实践中表现为「指向一个查不到的计划」。
    expect(result.data.alertPlanReason).toBe('alert-plan-not-found');
  });

  it('③ alertPlanId 有但查不到（计划已删）→ 缺席 + 另一种原因', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.watchTrigger.save(trigger({ alertPlanId: 'plan-gone' }));

    const result = await resolveWatchNotificationTool.execute({ triggerId: 'tr-1' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.alertPlan).toBeUndefined();
    expect(result.data.alertPlanReason).toBe('alert-plan-not-found');
  });

  it('**不伪造**：输出里没有 state / changes / sourcePlan / latestVersion（连 null 都没有）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.watchTrigger.save(trigger({ alertPlanId: 'plan-1' }));
    await ctx.repos.alertPlan.save(plan() as never);

    const result = await resolveWatchNotificationTool.execute({ triggerId: 'tr-1' }, ctx);
    if (!result.ok) throw new Error('failed');
    const keys = Object.keys(result.data);
    for (const forbidden of ['state', 'changes', 'sourcePlan', 'latestVersion'])
      expect(keys, forbidden).not.toContain(forbidden);
    // 但**必须**有「为什么不可用」的原因——这条恒出现。
    expect(result.data.unavailableReason).toBe(RESOLVE_WATCH_NOTIFICATION_UNAVAILABLE_REASON);
  });

  it('trigger 不存在 → not_found', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const result = await resolveWatchNotificationTool.execute({ triggerId: 'nope' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_found');
  });
});
