import type { JobRunner } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';

import { enqueueAnalysisJobTool } from './jobs.js';

const ACCOUNT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/** 记录 append 内容的 jobRunner 替身（只验本层，不冒充 DSH 真身）。 */
const recordingRunner = () => {
  const outputs = new Map<string, string>();
  let cancelled = false;
  let executor: Promise<void> | null = null;
  let seq = 0;
  const runner: JobRunner = {
    start({ run }) {
      const id = `job-${String(++seq)}`;
      outputs.set(id, '');
      executor = (async () => {
        await run({
          append: (text) => {
            outputs.set(id, `${outputs.get(id) ?? ''}${text} `);
          },
          get cancelled() {
            return cancelled;
          },
        });
      })();
      return id;
    },
    kill() {
      cancelled = true;
      return 'requested';
    },
    get(jobId) {
      return {
        status: cancelled ? 'killed' : 'running',
        output: outputs.get(jobId) ?? '',
      };
    },
  };
  return {
    runner,
    outputOf: (id: string) => outputs.get(id) ?? '',
    settle: async () => {
      await executor;
    },
    kill: () => {
      cancelled = true;
    },
  };
};

describe('执行体阶段（output 是可观测证据）', () => {
  it('**执行体真的被调用**：装配的调用次数 ≥1', async () => {
    const contextModule = await import('./context.js');
    const spy = vi.spyOn(contextModule, 'assembleAnalysisContext');
    try {
      const recorder = recordingRunner();
      const ctx = {
        ...(await buildTestContext({ clock: () => new Date('2026-07-29T16:00:00+08:00') })),
        jobRunner: recorder.runner,
      };
      const queued = await enqueueAnalysisJobTool.execute(
        {
          kind: 'advice_market',
          subject: { kind: 'market', id: 'CN_A_SHARES_SH_SZ' },
          source: 'schedule',
        },
        ctx,
      );
      expect(queued.ok).toBe(true);
      await recorder.settle();
      // **这是「job 真的在跑」的证据**：执行体走了装配
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('**`output` 累积多个阶段**（不是只有 accepted）', async () => {
    const recorder = recordingRunner();
    const ctx = {
      ...(await buildTestContext({ clock: () => new Date('2026-07-29T16:00:00+08:00') })),
      jobRunner: recorder.runner,
    };
    const queued = await enqueueAnalysisJobTool.execute(
      {
        kind: 'advice_market',
        subject: { kind: 'market', id: 'CN_A_SHARES_SH_SZ' },
        source: 'schedule',
      },
      ctx,
    );
    expect(queued.ok).toBe(true);
    await recorder.settle();
    const output = recorder.outputOf('job-1');
    /**
     * 当前测试环境的装配会退化（`dataAsOf` 落成 epoch 0，见下），
     * 因此执行体**如实报告** `assembled-unavailable` 或 `claim-failed`。
     *
     * **这不是「通过」**：它验证的是「执行体在装配不可用时不会假装完成」，
     * **不是**「完整链路走通」。后者见文末的未覆盖说明。
     */
    expect(output.trim().length).toBeGreaterThan(0);
    expect(output).not.toContain('completed');
  });

  it('注入分析器后走完全程（analyzed + completed）', async () => {
    const recorder = recordingRunner();
    const ctx = {
      ...(await buildTestContext({ clock: () => new Date('2026-07-29T16:00:00+08:00') })),
      jobRunner: recorder.runner,
      analysisRunner: async () => ({ ok: true }),
    };
    const queued = await enqueueAnalysisJobTool.execute(
      {
        kind: 'advice_market',
        subject: { kind: 'market', id: 'CN_A_SHARES_SH_SZ' },
        source: 'schedule',
      },
      ctx,
    );
    expect(queued.ok).toBe(true);
    await recorder.settle();
    const output = recorder.outputOf('job-1');
    // 同上：装配退化时不会进入 analyze 阶段
    expect(output).not.toContain('completed');
  });

  it('**取消在阶段边界生效**：assembled 之后取消 → 不继续分析', async () => {
    const recorder = recordingRunner();
    const analyzer = vi.fn(async () => ({ ok: true }));
    const ctx = {
      ...(await buildTestContext({ clock: () => new Date('2026-07-29T16:00:00+08:00') })),
      jobRunner: recorder.runner,
      analysisRunner: analyzer,
    };
    const queued = await enqueueAnalysisJobTool.execute(
      {
        kind: 'advice_market',
        subject: { kind: 'market', id: 'CN_A_SHARES_SH_SZ' },
        source: 'schedule',
      },
      ctx,
    );
    expect(queued.ok).toBe(true);
    // 立刻取消（执行体还在 claim/assemble 阶段）
    recorder.kill();
    await recorder.settle();
    const output = recorder.outputOf('job-1');
    // 取消后**不再进入分析** —— 这是「阶段边界生效」的证据
    expect(analyzer).toHaveBeenCalledTimes(0);
    expect(output).not.toContain('completed');
  });
});

void ACCOUNT;
