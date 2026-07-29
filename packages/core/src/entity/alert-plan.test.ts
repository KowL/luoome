import { describe, expect, it } from 'vitest';

import { AlertPlanSchema, assertAlertPlanInvariants } from './alert-plan.js';

const T0 = new Date('2026-07-29T00:00:00.000Z');

describe('AlertPlan', () => {
  it('接受 strategy-signal 规则并保持稳定 ruleId', () => {
    const plan = AlertPlanSchema.parse({
      id: 'quality-alert',
      name: '质量策略提醒',
      watchlistId: 'quality-watch',
      rules: [
        {
          id: 'quality-entry',
          kind: 'strategy-signal',
          strategyId: 'quality',
          ruleId: 'entry',
          minScore: 70,
          direction: 'bullish',
        },
      ],
      logic: 'ANY',
      triggerMode: 'on-enter',
      cooldownMinutes: 30,
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(() => assertAlertPlanInvariants(plan)).not.toThrow();
    expect(plan.rules[0]).toMatchObject({ kind: 'strategy-signal', ruleId: 'entry' });
  });

  it('拒绝重复规则 id 和逆序时间', () => {
    const base = {
      id: 'duplicate-alert',
      name: '重复',
      watchlistId: 'watchlist',
      rules: [
        { id: 'same', kind: 'price-change' as const, pct: 0.05 },
        { id: 'same', kind: 'price-level' as const, level: 10, side: 'above' as const },
      ],
      logic: 'ANY' as const,
      triggerMode: 'on-enter' as const,
      cooldownMinutes: 30,
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: new Date(T0.getTime() - 1),
    };
    expect(() => assertAlertPlanInvariants(AlertPlanSchema.parse(base))).toThrow();
  });
});
