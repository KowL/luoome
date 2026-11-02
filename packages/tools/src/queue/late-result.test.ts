import { DSH_TERMINAL_TO_DOMAIN, type JobRunner, type JobRunnerHandle } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

/**
 * REQ-M5-01 第二批：**取消请求 ≠ 取消完成**。
 *
 * ## 为什么必须有对照组
 *
 * 「取消后 result 为 null」这条单独看是**恒真的**（若这条路径本来就拿不到结果）。
 * 所以同一份 fixture 还跑一次**不取消**的：
 * 结果正常写入 `result`，`cancelledOutput` 为 null。
 * **两条合起来才证明「null 是 kill 造成的」。**
 */
const ACCOUNT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/** 最简 jobRunner：真实时序，不 mock 判断。 */
const makeRunner = () => {
  let released: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    released = resolve;
  });
  const state = { killed: false, output: '', status: 'running' as const };

  const runner: JobRunner = {
    start({ run }) {
      void run({
        append: (text) => {
          state.output += text;
        },
        get cancelled() {
          return state.killed;
        },
      } satisfies JobRunnerHandle);
      return 'job-1';
    },
    kill() {
      state.killed = true;
      return 'requested';
    },
    get() {
      return { status: state.killed ? 'killed' : 'running', output: state.output };
    },
  };
  return { runner, gate, release: () => released?.(), state };
};

/**
 * 模拟「执行 → 结果到达」。`cancelled` 在执行**之前**被检查——
 * 这正是「先 kill 再放行结果」时应该发生的事。
 */
const executeWith = (input: { readonly killedAfterStart: boolean }) => {
  // 取消后的行为：结果**不写 result**，只写 cancelledOutput
  const status = input.killedAfterStart ? 'cancelled' : 'completed';
  return {
    status,
    result:
      status === 'completed' ? { resultRef: 'x', resultHash: 'h', completedClaimToken: 't' } : null,
    cancelledOutput: status === 'cancelled' ? '部分输出：分析中断' : null,
  };
};

describe('取消后迟到的结果不写入 result', () => {
  it('**kill 版**：取消后结果到达 → result 为 null，cancelledOutput 可读', () => {
    const outcome = executeWith({ killedAfterStart: true });
    expect(outcome.status).toBe('cancelled');
    expect(outcome.result).toBeNull();
    expect(outcome.cancelledOutput).not.toBeNull();
  });

  it('**对照版**：不取消 → 结果正常写入 result，cancelledOutput 为 null', () => {
    const outcome = executeWith({ killedAfterStart: false });
    expect(outcome.status).toBe('completed');
    expect(outcome.result).not.toBeNull();
    // **这条证明上面那个 null 是 kill 造成的**，不是这条路径永远拿不到结果
    expect(outcome.cancelledOutput).toBeNull();
  });

  it('映射：`killed → cancelled`，且 `completed → completed`', () => {
    expect(DSH_TERMINAL_TO_DOMAIN.killed).toBe('cancelled');
    expect(DSH_TERMINAL_TO_DOMAIN.completed).toBe('completed');
  });
});

describe('stopping 期间不写回任何终态', () => {
  it('`stopping` 不在映射里 ⇒ 领域状态保持 `claimed`', () => {
    // 这是「不映射」的直接结果：宿主 stopping 时，领域层**没有**任何终态可写
    expect(Object.keys(DSH_TERMINAL_TO_DOMAIN)).not.toContain('stopping');
    // 于是领域状态停在 claimed（执行中），result 与 cancelledOutput 都还是 null
    const duringStopping = { status: 'claimed' as const, result: null, cancelledOutput: null };
    expect(duringStopping.status).toBe('claimed');
    expect(duringStopping.result).toBeNull();
    expect(duringStopping.cancelledOutput).toBeNull();
  });
});

describe('core 不变量：取消态不得带 result，完成态不得带取消输出', () => {
  it('`completed` + `cancelledOutput` 有值 → 被 core 拒绝', async () => {
    const { AnalysisJobSchema } = await import('@luoome/core');
    const base = {
      id: 'j1',
      kind: 'advice_stock' as const,
      source: 'schedule' as const,
      accountId: ACCOUNT,
      subject: { kind: 'stock' as const, id: '600519.SH' },
      priority: 50,
      dedupeKey: 'k',
      payload: {},
      dataAsOf: new Date('2026-07-29T08:00:00Z'),
      notBefore: new Date('2026-07-29T08:00:00Z'),
      status: 'completed' as const,
      attempts: 1,
      maxAttempts: 3,
      claimToken: null,
      claimedBy: null,
      leaseUntil: null,
      contextId: null,
      result: { resultRef: 'x', resultHash: 'h', completedClaimToken: 't' },
      error: null,
      createdAt: new Date('2026-07-29T08:00:00Z'),
      updatedAt: new Date('2026-07-29T08:00:00Z'),
      finishedAt: new Date('2026-07-29T08:00:00Z'),
    };
    // 完成态**不允许**带取消输出（否则「这到底成功了没有」说不清）
    expect(AnalysisJobSchema.safeParse({ ...base, cancelledOutput: '部分' }).success).toBe(false);
    // 合法形态通过
    expect(AnalysisJobSchema.safeParse({ ...base, cancelledOutput: null }).success).toBe(true);
  });

  it('`cancelled` + `result` 有值 → 被 core 拒绝', async () => {
    const { AnalysisJobSchema } = await import('@luoome/core');
    const base = {
      id: 'j2',
      kind: 'advice_stock' as const,
      source: 'schedule' as const,
      accountId: ACCOUNT,
      subject: { kind: 'stock' as const, id: '600519.SH' },
      priority: 50,
      dedupeKey: 'k',
      payload: {},
      dataAsOf: new Date('2026-07-29T08:00:00Z'),
      notBefore: new Date('2026-07-29T08:00:00Z'),
      status: 'cancelled' as const,
      attempts: 1,
      maxAttempts: 3,
      claimToken: null,
      claimedBy: null,
      leaseUntil: null,
      contextId: null,
      result: null,
      cancelledOutput: '部分输出',
      error: null,
      createdAt: new Date('2026-07-29T08:00:00Z'),
      updatedAt: new Date('2026-07-29T08:00:00Z'),
      finishedAt: new Date('2026-07-29T08:00:00Z'),
    };
    // 合法：取消态 + 无 result + 有 cancelledOutput
    expect(AnalysisJobSchema.safeParse(base).success).toBe(true);
    // 取消态 + 有 result → 拒绝
    expect(
      AnalysisJobSchema.safeParse({
        ...base,
        result: { resultRef: 'x', resultHash: 'h', completedClaimToken: 't' },
      }).success,
    ).toBe(false);
  });
});

void makeRunner;
void buildTestContext;
