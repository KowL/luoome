import { WatchTriggerSchema } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { toolRegistry } from '../registry.js';
import { buildTestContext } from '../testing/context.js';
import { resolveWatchNotificationTool } from '../tools/resolve-watch-notification.js';
import { resolveHostedWatchNotificationTool } from './watch.js';

const NOW = new Date('2026-08-01T00:00:00.000Z');

/**
 * P1 裁定的静态守卫（task-40 / M4-01）。
 *
 * 仓里有两个 resolver，分工是刻意的：
 * - `resolve_watch_notification`：**模型可调的唯一入口**，只给不可变依据；
 * - `resolve_hosted_watch_notification`：**内部实现**，带 `state`/`monitoring` 等**随时点变**的
 *   监控资格判定。
 *
 * 后者一旦进了 registry 或 allowlist，模型会把「需要现算的资格」当成「已核对过的事实」，
 * 而 `state` 三档的口径还有 4 项待产品裁定（task-40 报告 §4.3）。所以这里是**硬守卫**，
 * 不是提示：以后谁想把它加进去，必须先过这条测试并说明 `state` 口径已定。
 */
describe('两个 resolver 的暴露面守卫', () => {
  it('模型可调入口 resolve_watch_notification 在 registry 内', () => {
    const names = toolRegistry.all().map((tool) => tool.name);
    expect(names).toContain(resolveWatchNotificationTool.name);
  });

  it('内部实现 resolve_hosted_watch_notification 不得进 registry', () => {
    const names = toolRegistry.all().map((tool) => tool.name);
    expect(names).not.toContain(resolveHostedWatchNotificationTool.name);
    // 名字也不能以别的形式混进来（例如同名单的 re-export）。
    expect(names.filter((name) => name === 'resolve_hosted_watch_notification')).toHaveLength(0);
  });

  it('两者是不同实现，不是同一对象的别名：内部实现带 state，入口不带', async () => {
    expect(resolveHostedWatchNotificationTool.name).not.toBe(resolveWatchNotificationTool.name);
    // 用真实执行结果的字段集合判分工，而不是扒 schema 内部形状：
    // `outputSchema` 的类型是 `ZodType`，没有 `.shape`。
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.watchTrigger.save(
      WatchTriggerSchema.parse({
        id: 'tr-guard',
        poolId: 'alert-guard',
        stockId: '600519.SH',
        ruleId: 'rule-guard',
        ruleKind: 'price-level',
        direction: 'watch',
        triggerType: 'triggered',
        reason: '守卫用触发记录',
        evidence: ['守卫'],
        priority: 'normal',
        deliveryStatus: 'not-requested',
        evalSnapshot: { ruleId: 'rule-guard' },
        createdAt: NOW,
        notified: false,
      }),
    );

    const entry = await resolveWatchNotificationTool.execute({ triggerId: 'tr-guard' }, ctx);
    if (!entry.ok) throw new Error('entry failed');
    const entryKeys = Object.keys(entry.data);
    // 入口：只有不可变依据 + 「为什么不可用」的原因。
    expect(entryKeys).toContain('alertPlanReason');
    expect(entryKeys).toContain('planSourceKind');
    expect(entryKeys).toContain('unavailableReason');
    expect(entryKeys).not.toContain('state');
    expect(entryKeys).not.toContain('monitoring');

    const hosted = await resolveHostedWatchNotificationTool.execute({ triggerId: 'tr-guard' }, ctx);
    if (!hosted.ok) throw new Error('hosted failed');
    const hostedKeys = Object.keys(hosted.data);
    // 内部实现：带随时点变的资格判定。
    expect(hostedKeys).toEqual(expect.arrayContaining(['state', 'monitoring', 'changes']));
    expect(hostedKeys).not.toContain('unavailableReason');
  });
});
