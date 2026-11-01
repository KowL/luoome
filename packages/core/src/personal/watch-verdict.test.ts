import { describe, expect, it } from 'vitest';

import {
  WATCH_NOTIFICATION_REASONS,
  WATCH_NOTIFICATION_STATES,
  WatchNotificationVerdictSchema,
  watchNotificationVerdictFromMonitoring,
} from './watch.js';

/**
 * 外部评审决策 2：`state` 三档 → 四档 + 原因码。
 *
 * 判据是「**我们能证明什么**」，不是「谁的错」：
 * - `conditions-unchecked`：门槛全过，只差用当前行情重新核验触发条件
 * - `ineligible`：**已证实**不具备资格（过期 / 账户变化 / 门槛未过 / 未到生效时间）
 * - `facts-unavailable`：缺事实，**只证明「无法判断」**
 * - `source-unavailable`：对应来源无法解析
 */
describe('watchNotificationVerdictFromMonitoring（四档唯一映射）', () => {
  it('四档枚举就是这四个，不多不少', () => {
    expect([...WATCH_NOTIFICATION_STATES]).toEqual([
      'conditions-unchecked',
      'ineligible',
      'facts-unavailable',
      'source-unavailable',
    ]);
    // 旧的三档名字一个都不能留：留着就会有人接着用。
    for (const legacy of ['requires-recheck', 'changed', 'unavailable'])
      expect(WATCH_NOTIFICATION_STATES as readonly string[]).not.toContain(legacy);
  });

  it('ready → conditions-unchecked（且不带原因码）', () => {
    expect(watchNotificationVerdictFromMonitoring({ status: 'ready' })).toEqual({
      state: 'conditions-unchecked',
    });
    // 带原因码 = 把「合格」重新说成「有毛病」，schema 必须拒绝。
    expect(() =>
      WatchNotificationVerdictSchema.parse({
        state: 'conditions-unchecked',
        reason: 'expired',
      }),
    ).toThrow();
  });

  it('facts-unavailable 只从「读不到账户事实」来', () => {
    expect(
      watchNotificationVerdictFromMonitoring({ status: 'unavailable', reason: '账户事实不可用' }),
    ).toEqual({ state: 'facts-unavailable', reason: 'facts-unavailable' });
  });

  it('已证实的过期归 ineligible，不被缺数状态掩盖', () => {
    expect(watchNotificationVerdictFromMonitoring({ status: 'expired' })).toEqual({
      state: 'ineligible',
      reason: 'expired',
    });
  });

  it('可靠的指纹差异是 account-changed，不是 facts-unavailable', () => {
    expect(watchNotificationVerdictFromMonitoring({ status: 'account-changed' })).toEqual({
      state: 'ineligible',
      reason: 'account-changed',
    });
  });

  it('约束不通过归 ineligible/constraints-failed——它与「事实不可用」共用一个 monitoring.status，必须分开', () => {
    // `tradingPlanMonitoring` 用 `unavailable` 同时表达这两件事，靠 reason 区分。
    expect(
      watchNotificationVerdictFromMonitoring({ status: 'unavailable', reason: '计划约束未通过' }),
    ).toEqual({ state: 'ineligible', reason: 'constraints-failed' });
  });

  it('draft → ineligible/draft：重新检查行情不会让草案取得资格', () => {
    expect(watchNotificationVerdictFromMonitoring({ status: 'draft' })).toEqual({
      state: 'ineligible',
      reason: 'draft',
    });
  });

  it('scheduled → ineligible/scheduled：validFrom 未到，不证明已排期', () => {
    expect(watchNotificationVerdictFromMonitoring({ status: 'scheduled' })).toEqual({
      state: 'ineligible',
      reason: 'scheduled',
    });
  });

  it('inactive / no-conditions 也都是 ineligible，且保留各自原因', () => {
    expect(watchNotificationVerdictFromMonitoring({ status: 'inactive' })).toEqual({
      state: 'ineligible',
      reason: 'inactive',
    });
    expect(watchNotificationVerdictFromMonitoring({ status: 'no-conditions' })).toEqual({
      state: 'ineligible',
      reason: 'no-conditions',
    });
  });

  it('每个 monitoring 状态都映射到恰好一个四档值，没有遗漏', () => {
    const statuses = [
      'ready',
      'draft',
      'inactive',
      'expired',
      'scheduled',
      'account-changed',
      'unavailable',
      'no-conditions',
    ] as const;
    for (const status of statuses) {
      const verdict = watchNotificationVerdictFromMonitoring({ status });
      expect(WATCH_NOTIFICATION_STATES as readonly string[]).toContain(verdict.state);
      // 除 conditions-unchecked 外都必须给原因，且原因在枚举内。
      if (verdict.state === 'conditions-unchecked') expect(verdict.reason).toBeUndefined();
      else expect(WATCH_NOTIFICATION_REASONS as readonly string[]).toContain(verdict.reason);
    }
  });

  it('未知 monitoring 状态不冒充合格，也不编造具体原因', () => {
    const verdict = watchNotificationVerdictFromMonitoring({ status: 'brand-new-status' });
    expect(verdict.state).toBe('facts-unavailable');
    expect(verdict.reason).toBe('facts-unavailable');
  });

  it('非 conditions-unchecked 缺原因码 → schema 拒绝（四档不许退回「压成一个词」）', () => {
    expect(() => WatchNotificationVerdictSchema.parse({ state: 'ineligible' })).toThrow();
    expect(() => WatchNotificationVerdictSchema.parse({ state: 'source-unavailable' })).toThrow();
  });
});
