import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { deleteStockEventTool } from './delete-stock-event.js';

const NOW = new Date('2026-08-03T02:00:00.000Z');

const event = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt-1',
  stockId: '600519.SH',
  kind: 'announcement' as const,
  title: '股东大会通知',
  occursAt: NOW,
  allDay: true,
  importance: 'important' as const,
  status: 'scheduled' as const,
  source: 'manual' as const,
  stale: false,
  remindBeforeDays: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('delete_stock_event tool（决策 3-B）', () => {
  it('摘要含身份与时间；不含事件标题等正文', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.stockEvent.save(event() as never);

    const result = await deleteStockEventTool.execute({ eventId: 'evt-1' }, ctx);
    if (!result.ok) throw new Error(`failed: ${JSON.stringify(result.error)}`);
    expect(result.data.ok).toBe(true);
    expect(result.data.summary).toEqual({
      eventId: 'evt-1',
      stockId: '600519.SH',
      eventKind: 'announcement',
      occursAt: NOW,
    });
    // 事件正文（标题）不得进入回执：删除的语义是让它消失。
    expect(JSON.stringify(result.data.summary)).not.toContain('股东大会通知');
    // 删除确实发生。
    expect(await ctx.repos.stockEvent.findById('evt-1')).toBeNull();
  });

  it('external 事件不可删（既有约束不变）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.stockEvent.save(
      event({ source: 'external', provider: 'eastmoney', externalId: 'em-1' }) as never,
    );
    const result = await deleteStockEventTool.execute({ eventId: 'evt-1' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
    // 拒绝时不得删除。
    expect(await ctx.repos.stockEvent.findById('evt-1')).not.toBeNull();
  });

  it('未命中 → not_found', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const result = await deleteStockEventTool.execute({ eventId: 'evt-gone' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
  });
});
