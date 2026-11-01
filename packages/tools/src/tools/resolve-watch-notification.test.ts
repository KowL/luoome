import {
  type TradingPlan,
  TradingPlanV2Schema,
  type WatchTrigger,
  WatchTriggerSchema,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  RESOLVE_WATCH_NOTIFICATION_UNAVAILABLE_REASON,
  resolveWatchNotificationTool,
  SOURCE_PLAN_LOOKUP_REASONS,
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

/** 交易计划 fixture：`TradingPlanV2Schema` 的区间宽度与选点都有硬约束，必须构造合法值。 */
const tradingPlan = (overrides: Partial<TradingPlan> = {}): TradingPlan =>
  TradingPlanV2Schema.parse({
    id: 'plan-1',
    version: 2,
    accountId: 'acct-1',
    stockId: '600519.SH',
    status: 'active',
    action: 'reduce',
    entryConditions: [],
    invalidEntryConditions: [],
    position: {
      currentPct: 20,
      targetPctRange: { min: 10, max: 12 },
      appliedPct: 10,
      fallbackPct: 10,
      rangePick: { ruleId: 'lower-bound' },
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: [],
    },
    holding: {
      minTradingDays: 1,
      maxTradingDays: 5,
      nextReviewAt: NOW,
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: { conditions: [], triggerConditions: [], canSellNow: true },
    validFrom: NOW,
    validUntil: new Date(NOW.getTime() + 86_400_000),
    invalidationConditions: [],
    invalidationRules: [
      {
        id: 'exit-stop',
        kind: 'price-threshold',
        phase: 'risk',
        metric: 'price',
        comparator: 'lte',
        value: 95,
        description: '跌破止损',
      },
    ],
    accountFactsAsOf: NOW,
    accountFactsDigest: 'digest-1',
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
    confidence: 50,
    createdAt: NOW,
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

  it('**不伪造**：输出里没有 state / changes / latestVersion（连 null 都没有）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.watchTrigger.save(trigger({ alertPlanId: 'plan-1' }));
    await ctx.repos.alertPlan.save(plan() as never);

    const result = await resolveWatchNotificationTool.execute({ triggerId: 'tr-1' }, ctx);
    if (!result.ok) throw new Error('failed');
    const keys = Object.keys(result.data);
    // `sourcePlan` 已不在禁用列表（task-40 P0：计划版本是**不可变**依据，可以给）；
    // 仍然禁的是三个「随时点变 / 需要现算」的东西。
    for (const forbidden of ['state', 'changes', 'latestVersion'])
      expect(keys, forbidden).not.toContain(forbidden);
    // 但**必须**有「为什么不可用」的原因——这条恒出现。
    expect(result.data.unavailableReason).toBe(RESOLVE_WATCH_NOTIFICATION_UNAVAILABLE_REASON);
  });

  // ── task-40 P0：`alertPlanId` 一字段两义 ──────────────────────────────
  // 这条是**缺陷的证明**：修前构造同样数据 → `alert-plan-not-found` 且没有任何计划依据。
  it('④ 计划类触发（alertPlanId 装的是 poolId）→ 给出所依据的计划版本，而不是 not-found', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.watchTrigger.save(
      trigger({
        id: 'tr-plan-1',
        poolId: 'trading-plan-watch:acct-1',
        alertPlanId: 'trading-plan-watch:acct-1',
        stockId: '600519.SH',
        ruleId: 'plan-1:v2:exit-stop',
        direction: 'sell',
        evalSnapshot: {
          planVersionId: 'plan-1:v2',
          conditionId: 'exit-stop',
          accountFactsDigest: 'digest-1',
          validUntil: NOW,
        },
      }),
    );
    await ctx.repos.tradingPlan.save(tradingPlan());

    const result = await resolveWatchNotificationTool.execute({ triggerId: 'tr-plan-1' }, ctx);
    if (!result.ok) throw new Error(`failed: ${JSON.stringify(result.error)}`);
    expect(result.data.planSourceKind).toBe('trading-plan-watch');
    // 关键：拿到的是**版本**，不是 planId——不可变的那一版。
    expect(result.data.sourcePlan).toMatchObject({
      planId: 'plan-1',
      versionId: 'plan-1:v2',
      version: 2,
      stockId: '600519.SH',
      accountFactsDigest: 'digest-1',
    });
    // 而且**不再**误报「查不到告警计划」。
    expect(result.data.alertPlan).toBeUndefined();
    expect(result.data.alertPlanReason).toBeUndefined();
  });

  it('⑤ 计划版本已被 remove → 缺席 + plan-version-not-found（不伪装成「没有计划」）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.watchTrigger.save(
      trigger({
        id: 'tr-plan-2',
        poolId: 'trading-plan-watch:acct-1',
        alertPlanId: 'trading-plan-watch:acct-1',
        ruleId: 'plan-gone:v1:exit-stop',
        evalSnapshot: {
          planVersionId: 'plan-gone:v1',
          conditionId: 'exit-stop',
          accountFactsDigest: 'digest-1',
          validUntil: NOW,
        },
      }),
    );
    const result = await resolveWatchNotificationTool.execute({ triggerId: 'tr-plan-2' }, ctx);
    if (!result.ok) throw new Error('failed');
    expect(result.data.sourcePlan).toBeUndefined();
    expect(result.data.sourcePlanReason).toBe(SOURCE_PLAN_LOOKUP_REASONS[0]);
  });

  it('⑥ 计划版本账户/股票与提醒不一致 → plan-mismatch（数据不一致，不是「计划变了」）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.watchTrigger.save(
      trigger({
        id: 'tr-plan-3',
        poolId: 'trading-plan-watch:acct-1',
        alertPlanId: 'trading-plan-watch:acct-1',
        stockId: '000001.SZ',
        ruleId: 'plan-1:v2:exit-stop',
        evalSnapshot: {
          planVersionId: 'plan-1:v2',
          conditionId: 'exit-stop',
          accountFactsDigest: 'digest-1',
          validUntil: NOW,
        },
      }),
    );
    await ctx.repos.tradingPlan.save(tradingPlan());
    const result = await resolveWatchNotificationTool.execute({ triggerId: 'tr-plan-3' }, ctx);
    if (!result.ok) throw new Error('failed');
    expect(result.data.sourcePlan).toBeUndefined();
    expect(result.data.sourcePlanReason).toBe(SOURCE_PLAN_LOOKUP_REASONS[1]);
  });

  it('⑦ 计划池前缀但 evalSnapshot 不自洽 → 不给版本，也不退化成「查告警计划」', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.watchTrigger.save(
      trigger({
        id: 'tr-plan-4',
        poolId: 'trading-plan-watch:acct-1',
        alertPlanId: 'trading-plan-watch:acct-1',
        ruleId: 'not-matching-any-version',
        evalSnapshot: { ruleId: 'not-matching-any-version' },
      }),
    );
    const result = await resolveWatchNotificationTool.execute({ triggerId: 'tr-plan-4' }, ctx);
    if (!result.ok) throw new Error('failed');
    expect(result.data.planSourceKind).toBe('trading-plan-watch');
    expect(result.data.sourcePlan).toBeUndefined();
    expect(result.data.sourcePlanReason).toBe(SOURCE_PLAN_LOOKUP_REASONS[2]);
    // 它终究不是 AlertPlan，所以也不去查 AlertPlan。
    expect(result.data.alertPlan).toBeUndefined();
  });

  it('trigger 不存在 → not_found', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const result = await resolveWatchNotificationTool.execute({ triggerId: 'nope' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_found');
  });
});
