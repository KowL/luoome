import type { ExternalStockEvent, StockEventProviderLike, ToolContext } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { syncStockEventsWorkflow } from './sync-stock-events.js';

const CLOCK = () => new Date('2026-07-25T01:00:00.000Z');

const fakeProvider = (
  events: (stockIds: readonly string[]) => readonly ExternalStockEvent[],
  opts: { name?: string; throwOnFetch?: boolean } = {},
): StockEventProviderLike => ({
  name: opts.name ?? 'fake',
  supportedKinds: ['earnings', 'unlock', 'dividend'],
  fetchEvents: async ({ stockIds }) => {
    if (opts.throwOnFetch) throw new Error('provider down');
    return events(stockIds);
  },
});

const withProviders = (
  ctx: ToolContext,
  providers: readonly StockEventProviderLike[],
): ToolContext => ({ ...ctx, eventProviders: providers });

const oneEarnings = (stockIds: readonly string[]): readonly ExternalStockEvent[] => {
  const stockId = stockIds[0];
  if (stockId === undefined) return [];
  return [
    {
      stockId,
      kind: 'earnings',
      title: 'Q2 财报',
      occursAt: new Date('2026-08-01T00:00:00.000Z'),
      importance: 'important',
      externalId: 'ext-q2',
    },
  ];
};

describe('sync-stock-events workflow', () => {
  it('provider 成功 → upsert 事件，WorkflowRun succeeded', async () => {
    const base = await buildTestContext({ clock: CLOCK });
    const ctx = withProviders(base, [fakeProvider(oneEarnings)]);
    const r = await syncStockEventsWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.status).toBe('succeeded');
    expect(r.data.upserted).toBe(1);
    const run = await ctx.repos.workflowRun.findById(r.data.runId);
    expect(run?.status).toBe('succeeded');
    expect(run?.workflowName).toBe('sync-stock-events');
  });

  it('重复执行幂等：不新增重复行', async () => {
    const base = await buildTestContext({ clock: CLOCK });
    const ctx = withProviders(base, [fakeProvider(oneEarnings)]);
    await syncStockEventsWorkflow.run({}, ctx);
    await syncStockEventsWorkflow.run({}, ctx);
    const all = await ctx.repos.stockEvent.list({});
    expect(all.filter((e) => e.externalId === 'ext-q2').length).toBe(1);
  });

  it('provider 失败 → 全失败记 failed + 旧事件标 stale', async () => {
    const base = await buildTestContext({ clock: CLOCK });
    // 先成功写一条
    let ctx = withProviders(base, [fakeProvider(oneEarnings)]);
    await syncStockEventsWorkflow.run({}, ctx);
    // 再失败一次（唯一 provider 失败 → 全失败）
    ctx = withProviders(base, [fakeProvider(oneEarnings, { throwOnFetch: true })]);
    const r = await syncStockEventsWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.status).toBe('failed');
    expect(r.data.staleMarked).toBeGreaterThanOrEqual(1);
    const all = await ctx.repos.stockEvent.list({});
    expect(all.find((e) => e.externalId === 'ext-q2')?.stale).toBe(true);
  });

  it('部分 provider 失败 → partial', async () => {
    const base = await buildTestContext({ clock: CLOCK });
    const ctx = withProviders(base, [
      fakeProvider(oneEarnings, { name: 'ok-src' }),
      fakeProvider(oneEarnings, { name: 'bad-src', throwOnFetch: true }),
    ]);
    const r = await syncStockEventsWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.status).toBe('partial');
  });

  it('未配置 provider → succeeded、upserted=0（不删旧）', async () => {
    const ctx = await buildTestContext({ clock: CLOCK });
    const r = await syncStockEventsWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.status).toBe('succeeded');
    expect(r.data.upserted).toBe(0);
  });
});
