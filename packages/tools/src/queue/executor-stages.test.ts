import type { JobRunner } from '@luoome/core';
import { money } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';

import { enqueueAnalysisJobTool } from './jobs.js';

const ACCOUNT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const NOW = new Date('2026-07-29T12:00:00+08:00');
const analysisResult = () => ({
  result: {
    decision: 'watch',
    confidence: 50,
    horizon: 'short',
    reasoning: { premise: '等待确认', evidence: ['已保存行情'], counterEvidence: ['量能不足'] },
    risks: ['信息有限'],
  },
  provenance: { generatorKind: 'dsh-worker', evidenceFactIds: ['quote:600519.SH'] },
});

/**
 * 造**装配能成功**的上下文（REQ-M5-01 fixture）。
 *
 * ## 为什么必须存行情
 *
 * `assembleAnalysisContext` 的 `dataAsOf` **只来自真实已存事实**——
 * `context.ts:117` 明确写着「不调用 adapter、不刷新外部数据、**也不用 `now` 伪造 `dataAsOf`**」。
 * 没有已存行情 ⇒ `verifiedAt` 为空 ⇒ `dataAsOf` 落成 epoch 0 ⇒ claim 判 `stale_context`。
 *
 * ## 范式来源
 *
 * 照搬 `analysis.test.ts:153-171` 的 `setup()`：`repos.quote.save` 一笔当日行情，
 * `observedAt` 即 `dataAsOf` 的来源。
 */
const setupWithFacts = async () => {
  const ctx = await buildTestContext({ clock: () => NOW, advices: [] });
  await ctx.repos.quote.save({
    stockId: '600519.SH',
    ts: NOW,
    observedAt: NOW,
    fetchedAt: NOW,
    timestampSource: 'upstream',
    open: money(100),
    high: money(101),
    low: money(99),
    close: money(100),
    volume: 1000,
    source: 'test',
  } as never);
  return ctx;
};

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
      await executor?.catch(() => undefined);
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
        ...(await setupWithFacts()),
        jobRunner: recorder.runner,
      };
      const queued = await enqueueAnalysisJobTool.execute(
        {
          kind: 'advice_stock',
          subject: { kind: 'stock', id: '600519.SH' },
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
      ...(await setupWithFacts()),
      jobRunner: recorder.runner,
    };
    const queued = await enqueueAnalysisJobTool.execute(
      {
        kind: 'advice_stock',
        subject: { kind: 'stock', id: '600519.SH' },
        source: 'schedule',
      },
      ctx,
    );
    expect(queued.ok).toBe(true);
    await recorder.settle();
    const output = recorder.outputOf('job-1');
    /**
     * 本用例**刻意不注入 `analysisRunner`**：验的是「没有分析器时执行体停在
     * `analyzer-unavailable`，**不假装 completed**」。
     *
     * 走到 `completed` 的那条在下个用例（注入分析器）。
     */
    expect(output).toContain('claimed');
    expect(output).toContain('assembled');
    expect(output).toContain('analyzer-unavailable');
    expect(output).not.toContain('completed');
    if (!queued.ok) throw new Error('enqueue failed');
    const failed = await ctx.repos.analysis.findJob(ctx.user.defaultAccountId, queued.data.jobId);
    expect(failed?.status).toBe('dead_letter');
    expect(failed?.error?.code).toBe('analyzer_unavailable');
    expect(failed?.result).toBeNull();
  });

  it('注入分析器后走完全程（analyzed + completed）', async () => {
    const recorder = recordingRunner();
    const ctx = {
      ...(await setupWithFacts()),
      jobRunner: recorder.runner,
      analysisRunner: async () => analysisResult(),
    };
    const queued = await enqueueAnalysisJobTool.execute(
      {
        kind: 'advice_stock',
        subject: { kind: 'stock', id: '600519.SH' },
        source: 'schedule',
      },
      ctx,
    );
    expect(queued.ok).toBe(true);
    await recorder.settle();
    const output = recorder.outputOf('job-1');
    expect(output).toContain('analyzed');
    expect(output).toContain('completed');
    if (!queued.ok) throw new Error('enqueue failed');
    const savedJob = await ctx.repos.analysis.findJob(ctx.user.defaultAccountId, queued.data.jobId);
    expect(savedJob?.status).toBe('completed');
    expect(savedJob?.result).not.toBeNull();
    expect(savedJob?.cancelledOutput).toBeNull();
    expect(await ctx.repos.advice.findById(savedJob?.result?.resultRef ?? '')).not.toBeNull();
  });

  it('does not complete a job from a success-shaped object without an analysis result', async () => {
    const recorder = recordingRunner();
    const ctx = {
      ...(await setupWithFacts()),
      jobRunner: recorder.runner,
      analysisRunner: async () => ({ ok: true }),
    };
    const queued = await enqueueAnalysisJobTool.execute(
      { kind: 'advice_stock', subject: { kind: 'stock', id: '600519.SH' }, source: 'schedule' },
      ctx,
    );
    if (!queued.ok) throw new Error('enqueue failed');
    await recorder.settle();
    const job = await ctx.repos.analysis.findJob(ctx.user.defaultAccountId, queued.data.jobId);
    expect(job?.status).toBe('dead_letter');
    expect(job?.error?.code).toBe('invalid_analysis_result');
    expect(job?.result).toBeNull();
    expect(await ctx.repos.advice.query({ includeExpired: true })).toEqual([]);
    expect(recorder.outputOf('job-1')).not.toContain('completed');
  });

  it('**取消在阶段边界生效**：assembled 之后取消 → 不继续分析', async () => {
    const recorder = recordingRunner();
    const analyzer = vi.fn(async () => analysisResult());
    const ctx = {
      ...(await setupWithFacts()),
      jobRunner: recorder.runner,
      analysisRunner: analyzer,
    };
    const queued = await enqueueAnalysisJobTool.execute(
      {
        kind: 'advice_stock',
        subject: { kind: 'stock', id: '600519.SH' },
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

/**
 * REQ-M5-01 第三批：取消版 / 对照版（PRD 最后两条）。
 *
 * **对照版是关键**：没有它，「取消版 result 为 null」可能是恒真的
 * （若这条路径本来就拿不到结果）。
 */
describe('取消与对照（result vs cancelledOutput）', () => {
  it('**取消版**：`analyzed` 之后取消 → result 为 null、cancelledOutput 可读', async () => {
    const recorder = recordingRunner();
    let releaseAnalysis!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAnalysis = resolve;
    });
    const ctx = {
      ...(await setupWithFacts()),
      jobRunner: recorder.runner,
      // 分析器在 gate 上等待 —— 让我们能在「analyzed 之前」插入取消
      analysisRunner: async () => {
        await gate;
        return analysisResult();
      },
    };
    const queued = await enqueueAnalysisJobTool.execute(
      {
        kind: 'advice_stock',
        subject: { kind: 'stock', id: '600519.SH' },
        source: 'schedule',
      },
      ctx,
    );
    expect(queued.ok).toBe(true);
    /**
     * 等到执行体真正进入分析阶段（它卡在 `gate` 上）再取消。
     *
     * 用轮询等 `assembled` 出现 —— 比数微任务可靠：
     * `claim` 与 `assemble` 都是 await，微任务数量会随实现变化。
     */
    for (let waited = 0; waited < 200; waited += 1) {
      if (recorder.outputOf('job-1').includes('assembled')) break;
      await new Promise((done) => setTimeout(done, 5));
    }
    recorder.kill();
    releaseAnalysis();
    await recorder.settle();
    const output = recorder.outputOf('job-1');
    // **取消后不写 completed**，而是报取消原因
    expect(output).not.toContain('completed');
    expect(output).toContain('cancelled-after-analyzed');
    if (!queued.ok) throw new Error('enqueue failed');
    const cancelledJob = await ctx.repos.analysis.findJob(
      ctx.user.defaultAccountId,
      queued.data.jobId,
    );
    expect(cancelledJob?.status).toBe('cancelled');
    expect(cancelledJob?.result).toBeNull();
    expect(cancelledJob?.cancelledOutput).toContain('assembled');
    expect(await ctx.repos.advice.query({ includeExpired: true })).toEqual([]);
  });

  it('**对照版**：不取消 → 走完 `analyzed` + `completed`', async () => {
    const recorder = recordingRunner();
    const ctx = {
      ...(await setupWithFacts()),
      jobRunner: recorder.runner,
      analysisRunner: async () => analysisResult(),
    };
    const queued = await enqueueAnalysisJobTool.execute(
      {
        kind: 'advice_stock',
        subject: { kind: 'stock', id: '600519.SH' },
        source: 'schedule',
      },
      ctx,
    );
    expect(queued.ok).toBe(true);
    await recorder.settle();
    const output = recorder.outputOf('job-1');
    // **这条证明上面那个「没有 completed」是取消造成的**
    expect(output).toContain('analyzed');
    expect(output).toContain('completed');
    if (!queued.ok) throw new Error('enqueue failed');
    const savedJob = await ctx.repos.analysis.findJob(ctx.user.defaultAccountId, queued.data.jobId);
    expect(savedJob?.status).toBe('completed');
    expect(savedJob?.result).not.toBeNull();
    expect(savedJob?.cancelledOutput).toBeNull();
    expect(await ctx.repos.advice.findById(savedJob?.result?.resultRef ?? '')).not.toBeNull();
  });
});
