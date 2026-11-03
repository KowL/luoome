import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { createDshJobRunner } from './job-runner.js';

/**
 * REQ-M5-01 第三批：宿主 `JobRunner` 实现。
 *
 * ## 这里的 `ctx.jobs` 是**最小替身**，不是 DSH 真身
 *
 * 真身是 `dsh-jobs-local` 的 `JobRegistry`（一个 cordis 服务，需要完整宿主生命周期）。
 * 单独起它需要 boot 一个 DSH 应用 —— 那属于**插件装配验收**，不是单元测试的范围。
 *
 * **所以这份测试验的是「本层实现是否正确地调用宿主契约」，不是「DSH 能不能跑」。**
 * 后者由 `analysis-surface.contract.e2e` / `mvp-journeys.e2e` 那类真实宿主测试覆盖。
 * **我不把这层替身当成「接线已验证」。**
 */
const fakeContext = () => {
  const started: { id: string; label: string }[] = [];
  const killed: string[] = [];
  const statuses = new Map<string, string>();
  const hooks = new Map<string, { cancel(): void }>();
  let seq = 0;
  const ctx = {
    jobs: {
      attachController: () => () => undefined,
      start(spec: {
        label: string;
        run: (job: { id: string; append: (t: string) => void }) => {
          cancel(): void;
          done: Promise<{ status: string }>;
        };
      }) {
        const id = `luoome-analysis-${String(++seq)}`;
        started.push({ id, label: spec.label });
        statuses.set(id, 'running');
        // 真实契约：`run` 同步返回 hooks，工作在其内部异步跑
        hooks.set(
          id,
          spec.run({
            id,
            append: () => undefined,
          }),
        );
        return id;
      },
      kill(id: string) {
        killed.push(id);
        if (statuses.get(id) !== 'running') return 'already-finished';
        statuses.set(id, 'killed');
        hooks.get(id)?.cancel();
        return 'requested';
      },
      get(id: string) {
        const status = statuses.get(id);
        return status === undefined ? undefined : { status };
      },
    },
  } as unknown as Context;
  return { ctx, started, killed, statuses };
};

describe('宿主 JobRunner：调用宿主契约', () => {
  it('`start` 同步返回 id，并把 label 传给宿主', () => {
    const { ctx, started } = fakeContext();
    const runner = createDshJobRunner(ctx);
    const id = runner.start({ label: 'advice_market · market:CN', run: async () => null });
    expect(typeof id).toBe('string');
    expect(started[0]?.label).toBe('advice_market · market:CN');
  });

  it('**`run` 会被真正执行**（不是只登记）', async () => {
    const { ctx } = fakeContext();
    const runner = createDshJobRunner(ctx);
    let executed = false;
    runner.start({
      label: 'x',
      run: async (handle) => {
        executed = true;
        handle.append('working');
        return { output: 'done' };
      },
    });
    // `run` 在宿主内部异步启动，给它一个微任务周期
    await Promise.resolve();
    await Promise.resolve();
    expect(executed).toBe(true);
  });

  it('`append` 累积到输出里（`get` 能读回）', async () => {
    const { ctx } = fakeContext();
    const runner = createDshJobRunner(ctx);
    const id = runner.start({
      label: 'x',
      run: async (handle) => {
        handle.append('第一段');
        handle.append('第二段');
        return { output: 'ok' };
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.get(id)?.output).toBe('第一段第二段');
  });

  it('`kill` 转发到宿主，并返回宿主的 `requested` / `already-finished`', () => {
    const { ctx, killed } = fakeContext();
    const runner = createDshJobRunner(ctx);
    const id = runner.start({ label: 'x', run: async () => null });
    expect(runner.kill(id, 'user-cancel')).toBe('requested');
    expect(killed).toEqual([id]);
    // 已结束的 job 再取消 → `already-finished`（调用方**不该改任何状态**）
    expect(runner.kill(id)).toBe('already-finished');
  });

  it('`handle.cancelled` 在 kill 后为 true（取消能被执行体感知）', async () => {
    const { ctx } = fakeContext();
    const runner = createDshJobRunner(ctx);
    const seen: boolean[] = [];
    // 用一个**可控的等待点**代替裸微任务：先让 `run` 跑到 await，
    // 再 kill，然后放行 —— 这样时序是确定的，不依赖微任务顺序。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const id = runner.start({
      label: 'x',
      run: async (handle) => {
        seen.push(handle.cancelled);
        await gate;
        seen.push(handle.cancelled);
        return null;
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen[0]).toBe(false); // kill 之前
    runner.kill(id);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.at(-1)).toBe(true); // kill 之后，执行体感知到取消
  });
});
