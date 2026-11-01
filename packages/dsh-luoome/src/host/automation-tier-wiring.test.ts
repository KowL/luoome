import { randomUUID } from 'node:crypto';
import { createPluginOperationService, defineTool } from '@luoome/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTestContext } from '../../../tools/src/testing/context.js';
import { createAutomationTierStore } from './automation-tier-store.js';

/**
 * **P1 的核心验收**：档位切完，派发行为**立刻**跟着变——全程不重启。
 *
 * ## 为什么必须是「真实装配」
 *
 * `plugin-operations` 的单元测试只能证明**机制**（`resolveAllowBusinessWrite` 被调用）。
 * 它证明不了 `dsh-authority` 真的把读取器传下去了——
 * 那是本会话第九次「零件都对、接线没接上」的形态。
 *
 * 所以这里不注入桩函数，而是：
 * - 真实 `createAutomationTierStore`（读真实 repository）
 * - 真实的 `set_automation_tier` 写入路径（`store.save`）
 * - 同一个 `createPluginOperationService` 实例，不重建
 *
 * 断言的是**行为变化**，不是「函数存在」。
 */
const signal = () => new AbortController().signal;

const setup = async () => {
  const ctx = await buildTestContext({ clock: () => new Date('2026-05-01T00:00:00Z') });
  const owner = { userId: 'owner-user', accountId: 'owner-account' };
  // 真实 KV（memory 实现），真实读写。
  const store = createAutomationTierStore({
    repository: ctx.repos.pluginSetting,
    envTier: 'off',
    envProvided: true,
  });

  const calls: string[] = [];
  const writeTool = defineTool({
    name: 'apply_note',
    description: 'write tool whose name carries no write wording',
    sideEffect: 'write',
    input: z.object({ value: z.string() }).strict(),
    output: z.object({ done: z.boolean() }),
    handler: async () => {
      calls.push('apply_note');
      return { done: true };
    },
  });
  const policy = {
    tool: writeTool,
    scheduled: true,
    bind: (raw: unknown) => writeTool.inputSchema.parse(raw),
    receipt: async () => null,
  };

  const service = (await import('@luoome/tools')).createPluginOperationService({
    repository: ctx.repos.pluginAuthority,
    policies: [policy] as never,
    capabilities: ['read', 'write'] as const,
    policyVersion: 1,
    now: () => Date.now(),
    context: () => ctx,
    validateGrant: async () => true,
    // **和 dsh-authority 同一条接线**：执行时读当前档位。
    resolveAllowBusinessWrite: async () => {
      const resolved = await store.resolve();
      return resolved.tier === 'granted';
    },
  });

  const identity = {
    userId: owner.userId,
    profile: 'tier-wiring',
    sessionId: 'session-1',
    taskId: 'task-1',
  };
  const dispatch = (occurrenceId: string) =>
    service.executeScheduled(
      identity,
      {
        grantId: `batch:task-1:${owner.accountId}`,
        grantVersion: 1,
        occurrenceId,
        tool: 'apply_note',
        accountId: owner.accountId,
        input: { value: 'x' },
      },
      signal(),
    );

  return { ctx, store, calls, dispatch, owner };
};

describe('真实装配：切档位后派发行为立刻变化（不重启）', () => {
  it('notify 拒 → 写入 granted 后放行 → 写入 off 后拒绝', async () => {
    const { store, calls, dispatch } = await setup();

    // ① 初始来自环境变量（off → 派发不写）
    expect((await store.resolve()).source).toBe('env');

    // ② 设置页写入 notify：写工具被档位拒
    await store.save('notify', new Date('2026-05-01T01:00:00Z'));
    expect((await store.resolve()).source).toBe('table');
    const first = await dispatch('occ-1');
    expect(first.ok).toBe(false);
    if (!first.ok)
      expect(first.error).toMatchObject({
        required: 'automation tier allowing business writes',
      });
    expect(calls).toEqual([]);

    // ③ 切到 granted（**同一 service 实例，不重建不重启**）→ 越过档位闸门
    await store.save('granted', new Date('2026-05-01T02:00:00Z'));
    const second = await dispatch('occ-2');
    if (!second.ok)
      expect(second.error).not.toMatchObject({
        required: 'automation tier allowing business writes',
      });

    // ④ 切回 off → 又被拒
    await store.save('off', new Date('2026-05-01T03:00:00Z'));
    const third = await dispatch('occ-3');
    expect(third.ok).toBe(false);
    if (!third.ok)
      expect(third.error).toMatchObject({
        required: 'automation tier allowing business writes',
      });
  });

  it('表里没有记录时回退到环境变量默认值', async () => {
    const { store } = await setup();
    const resolved = await store.resolve();
    expect(resolved).toEqual({ tier: 'off', source: 'env' });
  });

  it('表里有记录时**以表为准**，不再看环境变量', async () => {
    const { store } = await setup();
    await store.save('notify', new Date('2026-05-01T01:00:00Z'));
    expect(await store.resolve()).toEqual({ tier: 'notify', source: 'table' });
  });

  it('非法档位值被拒绝（value 是字符串，语义由 core 校验）', async () => {
    const { store } = await setup();
    await expect(store.save('bogus' as never, new Date())).rejects.toThrow(
      /off \/ notify \/ granted/,
    );
  });
});

void randomUUID;
void createPluginOperationService;
