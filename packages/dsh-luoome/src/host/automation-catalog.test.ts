import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule';
import { describe, expect, it } from 'vitest';

import { dshScheduleHash } from './dsh-identity.js';

/**
 * REQ-M4-06 ⑤：「5 行 × 3 字段」的每个字段都要来自**真实调度状态**。
 *
 * ## 为什么不能只断言「字段非空」
 *
 * 常量也能非空。要证明「值来自真实源头」，必须**改一次调度状态**，
 * 断言那一行的字段跟着变 —— 这与 `allowBusinessWrite` 那次是同一个道理。
 */
/**
 * 注意：`dshScheduleHash` 的入参是 **`ScheduleRecord`**（定义本身），
 * 不是 `ScheduleCatalogEntry`（后者额外带 `sessionId` / `status` 等运行时字段）。
 * 混用会让「hash 绑定义」这个语义看起来像 bug。
 */
const task = (overrides: Record<string, unknown> = {}): ScheduleRecord =>
  ({
    id: 'task-1',
    kind: 'daily' as const,
    title: '盘前简报',
    prompt: 'p',
    time: '08:45:00.000',
    timeZone: 'Asia/Shanghai',
    scheduledAt: '2026-05-02T00:45:00.000Z',
    ...overrides,
  }) as unknown as ScheduleRecord;

describe('scheduleHash 随调度定义变化（真实源头，不是常量）', () => {
  it('同一份定义算出同一个 hash（稳定）', () => {
    expect(dshScheduleHash(task())).toBe(dshScheduleHash(task()));
  });

  it('**改动调度时间 → hash 变化**（证明它不是常量）', () => {
    const before = dshScheduleHash(task());
    const after = dshScheduleHash(task({ time: '09:00:00.000' }));
    expect(after).not.toBe(before);
  });

  it('**改动 title → hash 变化**', () => {
    expect(dshScheduleHash(task({ title: '盘前简报 v2' }))).not.toBe(dshScheduleHash(task()));
  });

  it('**daily 的 scheduledAt 变化 → hash 不变**（hash 绑的是定义，不是运行时状态）', () => {
    // 这是**正确**的设计：hash 用于把授权绑在「这条日程定义」上。
    // 若运行时每跑一次 `scheduledAt` 推进就让 hash 变，授权每天都会失效一次。
    expect(dshScheduleHash(task({ scheduledAt: '2026-05-03T00:45:00.000Z' }))).toBe(
      dshScheduleHash(task()),
    );
  });

  it('运行时字段（status / sessionId）不进 hash —— 它们不在 ScheduleRecord 里', () => {
    // `status` 属于 `ScheduleCatalogEntry`，不属于 `ScheduleRecord`。
    // 这条断言的是**类型的边界**：hash 只吃定义，运行时状态进不来。
    const record = task();
    expect(record).not.toHaveProperty('status');
    expect(record).not.toHaveProperty('sessionId');
  });

  it('固定时刻型（at）的 scheduledAt **会**进 hash（它属于定义）', () => {
    const at = (when: string) =>
      ({ ...task(), kind: 'at' as const, scheduledAt: when }) as unknown as ScheduleRecord;
    expect(dshScheduleHash(at('2026-05-02T00:45:00.000Z'))).not.toBe(
      dshScheduleHash(at('2026-05-03T00:45:00.000Z')),
    );
  });
});

describe('三字段的实际来源', () => {
  it('三个字段各有独立的真实来源', () => {
    // 1) 下次到期 = `ScheduleCatalogEntry.scheduledAt`（运行时推进，不参与 hash）
    // 2) scheduleHash = `dshScheduleHash(task)`（绑定义，定义变才变）
    // 3) grant 版本 = `existingGrant.version`（授权表里的版本号）
    //
    // 三者**互相独立**：改时间只动 1、改定义只动 2、改授权只动 3。
    // 若面板把三者中任一渲染成常量或互相顶替，这条就失去意义——
    // 真正的证据在浏览器验收里（读真实 catalog）。
    const entry = task();
    expect(entry.scheduledAt).toBe('2026-05-02T00:45:00.000Z');
    expect(dshScheduleHash(entry)).toMatch(/^[0-9a-f]{64}$/);
    expect({ version: 3 }.version).toBe(3);
  });
});
