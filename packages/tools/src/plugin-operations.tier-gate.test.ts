import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineTool } from './define-tool.js';
import { type ConfirmablePluginTool, createPluginOperationService } from './plugin-operations.js';
import { buildTestContext } from './testing/context.js';

/**
 * REQ-M4-06 `notify` 档的业务写入闸门。
 *
 * ## 闸门只约束**定时派发**，不约束用户手动操作
 *
 * 档位说的是「**机器自己跑的时候**允许做什么」，不是「用户不能做什么」。
 * 所以下面对比两条路径：同样的写工具，手动 `prepare` 放行，定时 `executeScheduled` 被拒。
 *
 * ## 为什么必须端到端断言「真的被拒」
 *
 * 本会话反复出现「函数写好了但没人调用」（allowlist、`/execute`、`selected`、
 * 吞掉的 `result`、`historyCount`、`tierAllowsBusinessWrite` 自己）。
 * 所以这里不测「判定函数返回 false」，而是走完整 operation 流程，
 * 断言定时派发的写工具**真的拿到 permission_denied**、handler **真的没执行**。
 *
 * ## 为什么判据是 `sideEffect` 而不是工具名
 *
 * `apply_note` 是 write，但名字里没有任何写意味的词。
 * 按名字匹配的实现会放行它 —— mutation 已验证（`name.includes('save')` 会红）。
 */
const signal = () => new AbortController().signal;

const setup = async (options: { allowBusinessWrite?: boolean; tierOf?: () => string } = {}) => {
  const ctx = await buildTestContext({ clock: () => new Date('2026-05-01T00:00:00Z') });
  const owner = { userId: 'owner-user', accountId: 'owner-account' };
  const calls: string[] = [];
  const mkPolicy = (name: string, sideEffect: 'read' | 'write') => {
    const tool = defineTool({
      name,
      description: `test tool ${name}`,
      sideEffect,
      input: z.object({ value: z.string() }).strict(),
      output: z.object({ done: z.boolean() }),
      handler: async () => {
        calls.push(name);
        return { done: true };
      },
    });
    const policy: ConfirmablePluginTool = {
      tool,
      scheduled: true,
      bind: (raw) => tool.inputSchema.parse(raw),
      receipt: async () => null,
    };
    return policy;
  };

  const service = createPluginOperationService({
    repository: ctx.repos.pluginAuthority,
    policies: [
      mkPolicy('save_decision_review_stub', 'write'),
      // **名字不含 save/write/update/record**：按名字判的实现会让它漏网。
      mkPolicy('apply_note', 'write'),
      mkPolicy('get_something', 'read'),
    ],
    capabilities: ['read', 'write'] as const,
    policyVersion: 1,
    now: () => Date.now(),
    context: () => ctx,
    validateGrant: async () => true,
    ...(options.allowBusinessWrite === undefined
      ? {}
      : { allowBusinessWrite: options.allowBusinessWrite }),
    ...(options.tierOf === undefined
      ? {}
      : { resolveAllowBusinessWrite: () => options.tierOf?.() === 'granted' }),
  });

  const identity = {
    userId: owner.userId,
    profile: 'tier-gate-test',
    sessionId: 'session-1',
    taskId: 'task-1',
  };
  const scheduled = (tool: string) =>
    service.executeScheduled(
      identity,
      {
        grantId: `batch:task-1:${owner.accountId}`,
        grantVersion: 1,
        occurrenceId: `occ-${tool}`,
        tool,
        accountId: owner.accountId,
        input: { value: 'x' },
      },
      signal(),
    );

  return { ctx, service, owner, calls, scheduled };
};

describe('notify 档：定时派发的业务写入被拒（端到端）', () => {
  it('定时派发写工具 → permission_denied，且 handler 未执行', async () => {
    const { scheduled, calls } = await setup({ allowBusinessWrite: false });
    const result = await scheduled('save_decision_review_stub');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // **区分「档位拒」和「授权链拒」**：只证明它被拒了还不够，
    // 必须证明是档位拦的（required 字段是档位专属的）。
    expect(result.error).toMatchObject({ required: 'automation tier allowing business writes' });
    // 不是「函数返回了 false」：handler 根本没收到调用。
    expect(calls).toEqual([]);
  });

  it('名字不含 save/write 的写工具同样被拒（证明按 sideEffect 判，不按名字）', async () => {
    const { scheduled, calls } = await setup({ allowBusinessWrite: false });
    // `apply_note` 是 write，名字里没有任何写意味的词 —— 按名字判会漏网。
    const stealth = await scheduled('apply_note');
    expect(stealth.ok).toBe(false);
    if (!stealth.ok)
      expect(stealth.error).toMatchObject({
        required: 'automation tier allowing business writes',
      });
    expect(calls).toEqual([]);
  });

  it('只读工具在 notify 档**应当放行**（闸门不能误伤读）', async () => {
    const { scheduled, calls } = await setup({ allowBusinessWrite: false });
    const read = await scheduled('get_something');
    // 只读不该被**档位**挡掉（grant 链另说）。
    if (!read.ok)
      expect(read.error).not.toMatchObject({
        required: 'automation tier allowing business writes',
      });
    void calls;
  });

  it('allowBusinessWrite=true 时定时写工具不被档位拦（既有行为不变）', async () => {
    const { scheduled } = await setup();
    const result = await scheduled('save_decision_review_stub');
    // grant 不存在时的失败属于授权链，不是档位——只要不是被档位拒即可。
    if (!result.ok)
      expect(result.error).not.toMatchObject({
        required: 'automation tier allowing business writes',
      });
  });
});

describe('用户手动操作不受档位约束', () => {
  it('off/notify 档下，手动 prepare 写工具仍然放行', async () => {
    // 档位管的是「机器自己跑的时候允许做什么」，不是「用户不能做什么」。
    // 若有人把闸门加到 `prepare` 上，这条立刻红。
    const { service, owner } = await setup({ allowBusinessWrite: false });
    const result = await service.prepare(
      { userId: owner.userId, accountId: owner.accountId } as never,
      { id: crypto.randomUUID(), tool: 'save_decision_review_stub', input: { value: 'x' } },
    );
    expect(result.ok).toBe(true);
  });
});

/**
 * **P0 的核心验收**：切档位之后，派发行为**立刻**跟着变，全程不重启进程。
 *
 * ## 为什么这条最重要
 *
 * `allowBusinessWrite` 曾经是构造时常量。只验「表里存了新值」或「函数返回 true」，
 * 验的是**存储**，不是**接线**——用户改了档位、看起来成功了、行为却没变。
 *
 * 这条测试用同一个 service 实例、同一个工具、三次不同的档位读数，
 * 断言「拒绝 → 放行 → 拒绝」的转变。
 */
describe('P0：切档位后派发行为立刻变化（不重启）', () => {
  it('notify 拒 → granted 放 → off 不派发', async () => {
    // 可变档位：模拟设置页改了它。
    let tier: 'off' | 'notify' | 'granted' = 'notify';
    const { service, owner } = await setup({
      tierOf: () => tier,
      allowBusinessWrite: true,
    });
    const identity = {
      userId: owner.userId,
      profile: 'tier-gate-test',
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

    // ① notify：写工具被档位拒
    tier = 'notify';
    const first = await dispatch('occ-1');
    expect(first.ok).toBe(false);
    if (!first.ok)
      expect(first.error).toMatchObject({
        required: 'automation tier allowing business writes',
      });

    // ② 用户切到 granted（**同一个 service 实例，不重建、不重启**）
    tier = 'granted';
    const second = await dispatch('occ-2');
    // 这一次**必须越过档位闸门**（grant 链另说，但不能是档位拒）。
    if (!second.ok)
      expect(second.error).not.toMatchObject({
        required: 'automation tier allowing business writes',
      });

    // ③ 切回 off：派发本身不发生（档位拒）
    tier = 'off';
    const third = await dispatch('occ-3');
    expect(third.ok).toBe(false);
    if (!third.ok)
      expect(third.error).toMatchObject({
        required: 'automation tier allowing business writes',
      });
  });
});
