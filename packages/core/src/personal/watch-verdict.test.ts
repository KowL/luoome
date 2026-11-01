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

  // 旧版本这里断言的是「status=unavailable + reason='计划约束未通过' → constraints-failed」。
  // 决策 3-C 把那个 `reason` 文案耦合**删掉了**：core 现在直接给出 `constraints-failed`
  // 独立状态。所以旧断言必须改——**同一条规则，不再靠文案承载**。
  // 反向断言一起加上：带着旧文案的 `unavailable` 现在必须是「缺事实」，不能被文案带偏。
  it('约束结论由 status 承载，不再由 reason 文案承载（旧文案不再改变判定）', () => {
    expect(watchNotificationVerdictFromMonitoring({ status: 'constraints-failed' })).toEqual({
      state: 'ineligible',
      reason: 'constraints-failed',
    });
    // 旧实现会把这个组合判成 constraints-failed；现在它只能表示「账户事实不可用」。
    expect(
      watchNotificationVerdictFromMonitoring({ status: 'unavailable', reason: '计划约束未通过' }),
    ).toEqual({ state: 'facts-unavailable', reason: 'facts-unavailable' });
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

  // ── 决策 3-C：`unavailable` 一码三义拆分 ──
  it('约束明确不通过 → ineligible/constraints-failed（已确证，不是缺数据）', () => {
    expect(watchNotificationVerdictFromMonitoring({ status: 'constraints-failed' })).toEqual({
      state: 'ineligible',
      reason: 'constraints-failed',
    });
  });

  it('约束**事实**不可用 → facts-unavailable/constraints-unavailable（判不了 ≠ 不合格）', () => {
    expect(watchNotificationVerdictFromMonitoring({ status: 'constraints-unavailable' })).toEqual({
      state: 'facts-unavailable',
      reason: 'constraints-unavailable',
    });
  });

  it('账户事实缺失 → facts-unavailable/facts-unavailable（与上面两个互不混用）', () => {
    expect(watchNotificationVerdictFromMonitoring({ status: 'unavailable' })).toEqual({
      state: 'facts-unavailable',
      reason: 'facts-unavailable',
    });
  });

  // **核心验收**：改文案不改变结论 —— 证明 reason 文案判定真的删干净了。
  it('**改 monitoring.reason 文案不改变四档结论**', () => {
    const statuses = [
      'ready',
      'draft',
      'inactive',
      'expired',
      'scheduled',
      'account-changed',
      'unavailable',
      'constraints-failed',
      'constraints-unavailable',
      'no-conditions',
    ] as const;
    // 旧实现靠 `reason === '计划约束未通过'` 区分，改文案会静默改变判定；
    // 现在映射只看 status，任意文案的结果都必须完全一致。
    const texts = ['计划约束未通过', '账户事实不可用', '', '随便什么文案', '约束失败'];
    for (const status of statuses) {
      const baseline = watchNotificationVerdictFromMonitoring({ status });
      for (const reason of texts) {
        expect(
          watchNotificationVerdictFromMonitoring({ status, reason }),
          `${status} + reason="${reason}" 与基线不一致——文案仍参与判定`,
        ).toEqual(baseline);
      }
    }
  });

  it('已确证状态优先于缺事实：constraints-failed 与 unavailable 是不同结论', () => {
    const failed = watchNotificationVerdictFromMonitoring({ status: 'constraints-failed' });
    const missing = watchNotificationVerdictFromMonitoring({ status: 'unavailable' });
    // 一个说「不合格」，一个说「判不了」——绝不能相等。
    expect(failed).not.toEqual(missing);
    expect(failed.state).toBe('ineligible');
    expect(missing.state).toBe('facts-unavailable');
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
