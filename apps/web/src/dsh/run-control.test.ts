import { describe, expect, it } from 'bun:test';
import { DshRuntimeControl } from './run-control.js';

const identity = (runId: string, accountId = 'account-1') => ({
  runId,
  accountId,
  conversationId: `conversation-${runId}`,
});

const enter = (control: DshRuntimeControl, runId: string, accountId?: string) => {
  const admission = control.tryEnter(identity(runId, accountId));
  if (admission.kind !== 'admitted') throw new Error(`expected admitted, got ${admission.kind}`);
  return admission;
};

describe('DSH 运行闸门', () => {
  it('排空期间拒绝新 run，在途 run 完成后才确认排空', async () => {
    const control = new DshRuntimeControl();
    const first = enter(control, 'run-1');
    expect(control.activeRuns()).toBe(1);
    expect(control.activeSessions()).toEqual([
      { accountId: 'account-1', conversationId: 'conversation-run-1' },
    ]);
    const drain = control.beginDrain('配置升级');
    expect(drain).toEqual({ reason: '配置升级', activeRuns: 1 });
    expect(control.tryEnter(identity('run-2'))).toEqual({
      kind: 'draining',
      message: 'DSH 运行时正在排空（配置升级），新请求暂不可用，请稍后再试。',
    });
    expect(await control.waitForIdle(20)).toBe(false);
    expect(control.status()).toMatchObject({ accepting: false, activeRuns: 1 });
    first.release();
    first.release();
    expect(await control.waitForIdle(1_000)).toBe(true);
    expect(control.status()).toMatchObject({ accepting: false, activeRuns: 0 });
    control.resume();
    expect(control.status().accepting).toBe(true);
    enter(control, 'run-3').release();
    expect(control.activeRuns()).toBe(0);
  });

  it('账户阻断只影响目标账户，并按账户等待排空', async () => {
    const control = new DshRuntimeControl();
    const own = enter(control, 'run-own', 'account-1');
    const other = enter(control, 'run-other', 'account-2');
    control.blockAccount('account-1');
    expect(control.tryEnter(identity('run-2', 'account-1'))).toEqual({
      kind: 'account_blocked',
      message: '该账户的 DSH 会话正在被清理，暂不接受新请求。',
    });
    expect(control.tryEnter(identity('run-3', 'account-2')).kind).toBe('admitted');
    expect(await control.waitForAccountIdle('account-1', 20)).toBe(false);
    expect(await control.waitForAccountIdle('account-2', 20)).toBe(false);
    own.release();
    expect(await control.waitForAccountIdle('account-1', 1_000)).toBe(true);
    expect(control.activeRuns()).toBe(2);
    other.release();
    control.unblockAccount('account-1');
    expect(control.status().blockedAccounts).toEqual([]);
  });
});
