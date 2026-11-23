import { describe, expect, it } from 'bun:test';
import {
  CLOSED_DSH_ROLLOUT,
  DshRolloutGate,
  dshRolloutAllows,
  dshRolloutBucket,
} from './rollout.js';

describe('DSH 灰度门控', () => {
  it('默认关闭：开关未开启时不命中任何账户', () => {
    expect(CLOSED_DSH_ROLLOUT).toEqual({ enabled: false, accountAllowlist: [], percent: 0 });
    expect(dshRolloutAllows(CLOSED_DSH_ROLLOUT, 'account-1')).toBe(false);
    expect(new DshRolloutGate().allows('account-1')).toBe(false);
  });

  it('allowlist 直接命中，百分比按稳定哈希分桶', () => {
    const gate = new DshRolloutGate({ enabled: true, accountAllowlist: ['vip'], percent: 0 });
    expect(gate.allows('vip')).toBe(true);
    expect(gate.allows('account-1')).toBe(false);
    expect(dshRolloutBucket('vip')).toBe(dshRolloutBucket('vip'));
    const accounts = Array.from({ length: 200 }, (_value, index) => `account-${index}`);
    const selected = accounts.filter((account) =>
      dshRolloutAllows({ enabled: true, accountAllowlist: [], percent: 40 }, account),
    );
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(accounts.length);
    for (const account of accounts) {
      expect(dshRolloutAllows({ enabled: true, accountAllowlist: [], percent: 40 }, account)).toBe(
        dshRolloutAllows({ enabled: true, accountAllowlist: [], percent: 40 }, account),
      );
    }
    const full = { enabled: true, accountAllowlist: [], percent: 100 };
    expect(accounts.every((account) => dshRolloutAllows(full, account))).toBe(true);
  });

  it('一键回退后新请求不再命中，恢复开关重新放量', () => {
    const gate = new DshRolloutGate({ enabled: true, accountAllowlist: [], percent: 100 });
    expect(gate.allows('account-1')).toBe(true);
    gate.update({ ...CLOSED_DSH_ROLLOUT });
    expect(gate.allows('account-1')).toBe(false);
    expect(gate.policy.enabled).toBe(false);
    gate.update({ enabled: true, accountAllowlist: ['account-1'], percent: 0 });
    expect(gate.allows('account-1')).toBe(true);
    expect(gate.allows('account-2')).toBe(false);
  });
});
