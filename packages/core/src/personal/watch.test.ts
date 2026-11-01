import { describe, expect, it } from 'vitest';

import { type WatchTrigger, WatchTriggerSchema } from '../entity/watch-trigger.js';
import {
  TRADING_PLAN_WATCH_POOL_PREFIX,
  tradingPlanTriggerSource,
  tradingPlanWatchPoolId,
  watchTriggerPlanSource,
} from './watch.js';

const NOW = new Date('2026-08-01T00:00:00.000Z');

const trigger = (overrides: Record<string, unknown> = {}): WatchTrigger =>
  WatchTriggerSchema.parse({
    id: 'tr-1',
    poolId: 'alert-1',
    stockId: '600519.SH',
    ruleId: 'rule-1',
    ruleKind: 'price-level',
    direction: 'watch',
    triggerType: 'triggered',
    reason: '价格上穿 100',
    evidence: ['价格 100.00 上穿阈值 100'],
    priority: 'normal',
    deliveryStatus: 'not-requested',
    evalSnapshot: { ruleId: 'rule-1' },
    createdAt: NOW,
    notified: false,
    ...overrides,
  });

const planSnapshot = {
  planVersionId: 'plan-1:v2',
  conditionId: 'exit-stop',
  accountFactsDigest: 'digest-1',
  validUntil: NOW,
};

describe('watchTriggerPlanSource（REQ-M4-01 / task-40 P0）', () => {
  it('watchlist 规则触发：alertPlanId 就是 AlertPlan.id', () => {
    expect(watchTriggerPlanSource(trigger({ alertPlanId: 'alert-1' }))).toEqual({
      kind: 'alert-plan',
      alertPlanId: 'alert-1',
    });
  });

  it('计划类触发：识别为 trading-plan-watch 并给出 accountId 与版本', () => {
    // 这正是缺陷场景：alertPlanId 装的是 poolId，不是 AlertPlan.id。
    const source = watchTriggerPlanSource(
      trigger({
        poolId: tradingPlanWatchPoolId('acct-1'),
        alertPlanId: tradingPlanWatchPoolId('acct-1'),
        ruleId: 'plan-1:v2:exit-stop',
        evalSnapshot: planSnapshot,
      }),
    );
    expect(source).toEqual({
      kind: 'trading-plan-watch',
      accountId: 'acct-1',
      versionId: 'plan-1:v2',
      conditionId: 'exit-stop',
    });
  });

  it('计划池前缀优先于 AlertPlan.id 判定：即使存在同名计划也不认错', () => {
    // 池前缀是可判定的；`AlertPlan.id` 可能有任意取值，所以顺序不能反。
    const source = watchTriggerPlanSource(
      trigger({
        poolId: tradingPlanWatchPoolId('acct-1'),
        alertPlanId: 'alert-looks-the-same',
        ruleId: 'plan-1:v2:exit-stop',
        evalSnapshot: planSnapshot,
      }),
    );
    expect(source.kind).toBe('trading-plan-watch');
  });

  it('计划池前缀但 evalSnapshot 不自洽：仍是计划池，但给不出版本', () => {
    const source = watchTriggerPlanSource(
      trigger({
        poolId: tradingPlanWatchPoolId('acct-1'),
        alertPlanId: tradingPlanWatchPoolId('acct-1'),
        ruleId: 'plan-1:v9:exit-stop', // 与快照里的 v2 不一致
        evalSnapshot: planSnapshot,
      }),
    );
    expect(source).toEqual({ kind: 'trading-plan-watch', accountId: 'acct-1' });
    // 且**不能**退化成「查 AlertPlan」。
    expect(tradingPlanTriggerSource(trigger({ poolId: 'alert-1' }))).toBeNull();
  });

  it('既无池前缀也无 alertPlanId → unknown（不静默当成某个计划）', () => {
    expect(watchTriggerPlanSource(trigger({ poolId: 'pool-orphan' }))).toEqual({
      kind: 'unknown',
      raw: 'pool-orphan',
    });
  });

  it('前缀常量为空账户时不产生伪账户', () => {
    const source = watchTriggerPlanSource(trigger({ poolId: TRADING_PLAN_WATCH_POOL_PREFIX }));
    expect(source.kind).toBe('unknown');
  });
});
