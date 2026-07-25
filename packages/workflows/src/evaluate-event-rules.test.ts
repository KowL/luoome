import {
  type StockEvent,
  StockGroupSchema,
  StockPoolSchema,
  type ToolContext,
} from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { evaluateEventRulesWorkflow } from './evaluate-event-rules.js';

const CLOCK = () => new Date('2026-07-25T01:00:00.000Z');
/** now 的 Asia/Shanghai 当日 = 07-25；+3 自然日 = 07-28 00:00 SH = 07-27T16:00Z。 */
const EVENT_IN_3_DAYS = new Date('2026-07-27T16:00:00.000Z');

const seedPoolWithEventRule = async (
  ctx: ToolContext,
  opts: { importance?: 'normal' | 'important' | 'urgent'; daysBefore?: number[] } = {},
): Promise<StockEvent> => {
  const now = CLOCK();
  const group = StockGroupSchema.parse({
    id: 'evt-grp',
    name: '事件组',
    resolver: { kind: 'manual', stockIds: ['stk-evt'] },
    refreshPolicy: 'manual',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.repos.stockGroup.save(group);
  const pool = StockPoolSchema.parse({
    id: 'evt-pool',
    name: '事件方案',
    groupId: 'evt-grp',
    rules: [{ kind: 'event-date', id: 'r1', daysBefore: opts.daysBefore ?? [3] }],
    cooldownMinutes: 30,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.repos.stockPool.save(pool);
  const event: StockEvent = {
    id: 'evt-1',
    stockId: 'stk-evt',
    kind: 'earnings',
    title: 'Q2 财报',
    occursAt: EVENT_IN_3_DAYS,
    allDay: true,
    importance: opts.importance ?? 'important',
    status: 'scheduled',
    source: 'manual',
    stale: false,
    remindBeforeDays: [],
    createdAt: now,
    updatedAt: now,
  };
  await ctx.repos.stockEvent.save(event);
  return event;
};

describe('evaluate-event-rules workflow', () => {
  it('窗口命中 (d=3) → 生成 WatchTrigger；important → sent', async () => {
    const ctx = await buildTestContext({ clock: CLOCK });
    await seedPoolWithEventRule(ctx, { importance: 'important' });
    const r = await evaluateEventRulesWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggered).toBe(1);
    expect(r.data.notified).toBe(1);
    const triggers = await ctx.repos.watchTrigger.listRecent({ poolId: 'evt-pool' });
    expect(triggers.length).toBe(1);
    expect(triggers[0]?.eventId).toBe('evt-1');
    expect(triggers[0]?.ruleKind).toBe('event-date');
    expect(triggers[0]?.deliveryStatus).toBe('sent');
    expect((triggers[0]?.evalSnapshot as { remindDay?: number }).remindDay).toBe(3);
  });

  it('重复执行 → (event, remindDay) 去重', async () => {
    const ctx = await buildTestContext({ clock: CLOCK });
    await seedPoolWithEventRule(ctx);
    await evaluateEventRulesWorkflow.run({}, ctx);
    const second = await evaluateEventRulesWorkflow.run({}, ctx);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.triggered).toBe(0);
    expect(second.data.deduped).toBe(1);
  });

  it('normal 优先级 → not-requested（仅记录，不发送）', async () => {
    const ctx = await buildTestContext({ clock: CLOCK });
    await seedPoolWithEventRule(ctx, { importance: 'normal' });
    const r = await evaluateEventRulesWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggered).toBe(1);
    expect(r.data.notified).toBe(0);
    const triggers = await ctx.repos.watchTrigger.listRecent({ poolId: 'evt-pool' });
    expect(triggers[0]?.deliveryStatus).toBe('not-requested');
  });

  it('窗口外事件不触发', async () => {
    const ctx = await buildTestContext({ clock: CLOCK });
    await seedPoolWithEventRule(ctx, { daysBefore: [1] }); // 事件在 3 天后，规则只提醒 1 天前
    const r = await evaluateEventRulesWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggered).toBe(0);
  });
});
