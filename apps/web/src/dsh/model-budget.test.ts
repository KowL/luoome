import { describe, expect, it } from 'bun:test';
import { ModelBudgetLedger, sharedModelBudgetLedger } from './model-budget.js';

const FIXED = new Date('2026-11-24T00:00:00Z');
const ledger = (maxTokens: number, maxRequests = 10, windowMs = 3_600_000) =>
  new ModelBudgetLedger({ maxTokens, maxRequests, windowMs }, () => FIXED);

const admit = (value: ModelBudgetLedger, maxTokens = 100, runId = 'run-1', accountId = 'a1') =>
  value.admit({ accountId, runId, maxTokens });

describe('模型调用账本', () => {
  it('按真实 usage 结算后释放预占，预算耗尽拒绝下一次 attempt', () => {
    const value = ledger(60);
    const first = admit(value);
    expect(first).toEqual({
      kind: 'admitted',
      attemptId: expect.any(String),
      reservedTokens: 60,
    });
    expect(admit(value)).toEqual({ kind: 'exhausted', reason: 'tokens' });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    value.settle(first.attemptId, { inputTokens: 40, outputTokens: 15 });
    expect(value.snapshot('a1')).toMatchObject({
      tokensUsed: 55,
      tokensReserved: 0,
      unknownAttempts: 0,
    });
    const second = admit(value);
    expect(second).toMatchObject({ kind: 'admitted', reservedTokens: 5 });
    if (second.kind !== 'admitted') throw new Error('expected admitted');
    value.settle(second.attemptId, { inputTokens: 4, outputTokens: 1 });
    expect(admit(value)).toEqual({ kind: 'exhausted', reason: 'tokens' });
  });

  it('重试按请求数计入，请求额度耗尽后不再准入', () => {
    const value = ledger(1_000, 1);
    const first = admit(value);
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    value.settle(first.attemptId, null);
    expect(admit(value)).toEqual({ kind: 'exhausted', reason: 'requests' });
  });

  it('未知 usage 保留预占并记账，不归零', () => {
    const value = ledger(1_000);
    const first = admit(value, 200);
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    value.settle(first.attemptId, null);
    expect(value.snapshot('a1')).toMatchObject({
      tokensUsed: 200,
      tokensUnknown: 200,
      tokensReserved: 0,
      unknownAttempts: 1,
    });
    // 重复结算同一次 attempt 不会二次计入。
    value.settle(first.attemptId, { inputTokens: 1, outputTokens: 1 });
    expect(value.snapshot('a1').tokensUsed).toBe(200);
    const second = admit(value, 900);
    expect(second).toMatchObject({ kind: 'admitted', reservedTokens: 800 });
  });

  it('窗口滚动后重新放量，但仍在途的预占不会被清掉', () => {
    let now = FIXED;
    const value = new ModelBudgetLedger(
      { maxTokens: 100, maxRequests: 10, windowMs: 60_000 },
      () => now,
    );
    const first = admit(value, 100);
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    value.settle(first.attemptId, { inputTokens: 50, outputTokens: 50 });
    expect(admit(value, 10)).toEqual({ kind: 'exhausted', reason: 'tokens' });
    now = new Date(FIXED.getTime() + 60_000);
    expect(admit(value, 100)).toMatchObject({ kind: 'admitted', reservedTokens: 100 });
  });

  it('同一策略复用同一账本实例', () => {
    const policy = { maxTokens: 12_345, maxRequests: 7, windowMs: 1_000 };
    expect(sharedModelBudgetLedger(policy)).toBe(sharedModelBudgetLedger({ ...policy }));
  });
});
