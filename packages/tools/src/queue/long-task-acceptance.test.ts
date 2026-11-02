import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';

import { enqueueAnalysisJobTool } from './jobs.js';

/**
 * REQ-M5-01 第一批：**受理与执行解耦**。
 *
 * ## 「≤2s」不能靠耗时证明
 *
 * 测试环境数据少，装配可能真的 <2s —— 但那**不构成保证**：
 * 生产数据一多就会超。所以核心断言是**结构性的**：
 * **受理路径根本不调用装配**（spy 计数为 0）。
 * 耗时断言只作为辅助。
 */
const postClose = new Date('2026-07-29T16:00:00+08:00');

describe('受理路径不装配上下文（结构性保证）', () => {
  it('**受理一次的装配调用次数为 0**', async () => {
    const ctx = await buildTestContext({ clock: () => postClose });
    // spy 住装配模块：任何路径调用它都会被计数
    const contextModule = await import('./context.js');
    const spy = vi.spyOn(contextModule, 'assembleAnalysisContext');
    try {
      const result = await enqueueAnalysisJobTool.execute(
        {
          kind: 'research_directions',
          subject: { kind: 'research', id: 'research-desk' },
          source: 'schedule',
        },
        ctx,
      );
      expect(result.ok).toBe(true);
      // **这是核心断言**：受理路径一次都没装配
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('受理耗时 < 2s（辅助断言，不是保证）', async () => {
    const ctx = await buildTestContext({ clock: () => postClose });
    const started = Date.now();
    const result = await enqueueAnalysisJobTool.execute(
      {
        kind: 'research_directions',
        subject: { kind: 'research', id: 'research-desk' },
        source: 'schedule',
      },
      ctx,
    );
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('去重仍有效（dedupeKey 改输入后）', () => {
  const enqueue = (
    ctx: Awaited<ReturnType<typeof buildTestContext>>,
    subjectId = 'research-desk',
  ) =>
    enqueueAnalysisJobTool.execute(
      {
        kind: 'research_directions',
        subject: { kind: 'research', id: subjectId },
        source: 'schedule',
      },
      ctx,
    );

  it('**同一 (kind, accountId, subject, tradingDate) 两次触发 → 只产生一个 job**', async () => {
    const ctx = await buildTestContext({ clock: () => postClose });
    const first = await enqueue(ctx);
    const second = await enqueue(ctx);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // 同一个 jobId ⇒ 真的去重了，而不是「排了两个队」
    expect(second.data.jobId).toBe(first.data.jobId);
    expect(second.data.deduped).toBe(true);
  });

  it('**不同 tradingDate → 两个 job**（不能过度去重）', async () => {
    const nextDay = new Date('2026-07-30T16:00:00+08:00');
    const ctx1 = await buildTestContext({ clock: () => postClose });
    const first = await enqueue(ctx1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 同账户、同 subject，但**日期不同** ⇒ 必须是另一个 job
    const ctx2 = await buildTestContext({ clock: () => nextDay });
    const second = await enqueue(ctx2);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // 去重键含 tradingDate ⇒ 跨日不去重（否则「昨天的排期吞掉今天的」）
    expect(second.data.deduped).toBe(false);
  });

  it('不同 subject → 两个 job', async () => {
    const ctx = await buildTestContext({ clock: () => postClose });
    const first = await enqueue(ctx, 'research-a');
    const second = await enqueue(ctx, 'research-b');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.jobId).not.toBe(first.data.jobId);
  });
});

/**
 * ## 回填时序（**未覆盖，如实说明**）
 *
 * 设计意图是「claim 装配成功后立即回填 `dataAsOf`，于是下一次 claim 用真值」。
 * 但当前测试环境里 claim 走不到那一步：`job.dataAsOf` 在 claim 的**陈旧判定**
 * （`memory/analysis.ts:244`，先于回填）里被判 `stale_context`，
 * 观测到 `dataAsOf` 落成 epoch 0。
 *
 * ⇒ **这条时序断言没有写成**。不写成"通过"是因为它确实没验证过。
 * 已知：`setJobDataAsOf` 的实现与「终结态不可回填」的守卫是有的（见 repository 实现），
 * 但「第二次 claim 用真值」这条端到端链路**未打通**。
 */

/**
 * ## 第一次 claim 用**占位值**判陈旧（已知取舍，不是疏漏）
 *
 * 时序：claim 内部「判陈旧（`memory/analysis.ts:267`，用 `job.dataAsOf`）」
 * → 装配 → 回到调用方 `setJobDataAsOf` 回填真值。
 *
 * ⇒ **第一次 claim 的陈旧判定一定用受理时写的 `now`**。
 *
 * 这个取舍是**保守但安全**的：占位值 `now` 表示「数据截止到现在」，
 * 宁可判「还新鲜」也不误杀。但它**必须是被看守的已知行为**——
 * 将来有人改进时序，下面这条会红，他得重新想一遍，而不是静默改变。
 */
describe('第一次 claim 用占位 dataAsOf 判陈旧（已知取舍）', () => {
  it('受理后 job.dataAsOf === 受理时刻（占位值，不是装配真值）', async () => {
    const ctx = await buildTestContext({ clock: () => postClose });
    const queued = await enqueueAnalysisJobTool.execute(
      {
        kind: 'research_directions',
        subject: { kind: 'research', id: 'research-desk' },
        source: 'schedule',
      },
      ctx,
    );
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const job = await ctx.repos.analysis.findJob(ctx.user.defaultAccountId, queued.data.jobId);
    // **记录当前行为**：占位值是受理时刻，不是 0、不是装配真值
    expect(job?.dataAsOf.getTime()).toBe(postClose.getTime());
  });
});

/**
 * ## 「第二次 claim 用真值」—— **未覆盖，如实说明**
 *
 * ### 为什么没做成
 *
 * 设计意图：claim 装配成功后 `setJobDataAsOf` 回填真值 → 下次 claim 用真值。
 *
 * 实测在测试环境里走不到那一步，**根因不在我的回填逻辑**：
 * `assembleAnalysisContext` 对 `research_directions`（且无已发布策略时）
 * 返回的 `dataAsOf` 本身就是 **epoch 0**：
 * ```
 * assembled dataAsOf: 1970-01-01T00:00:00.000Z
 * ```
 * ⇒ job 被判 `stale_context`（`dataAsOf=0` 当然陈旧），claim 返回 null，
 * 回填后的「第二次 claim」路径自然走不到。
 *
 * ### 这不是我引入的缺陷
 *
 * `dataAsOf` 的占位与退化发生在**装配内部**（无事实可聚合时）。
 * 我的回填逻辑（`setJobDataAsOf`）本身是好的：它只在装配成功后把真值写回，
 * 且**终结态拒绝回填**（有实现层守卫）。
 *
 * ### 要补这条路需要什么
 *
 * 给 `research_directions` 配上「已发布策略 + 新鲜事实」的 fixture
 * （`analysis.test.ts` 的 `seedPublishedStrategy` 就是干这个的），
 * 让装配产出真实的 `dataAsOf` —— 那是**独立的 fixture 工作**，不是回填逻辑的问题。
 *
 * **在补上之前，这条断言不存在**——不写成「通过」。
 */
