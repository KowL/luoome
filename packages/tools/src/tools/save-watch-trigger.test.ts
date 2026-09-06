import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../registry.js';
import { buildTestContext } from '../testing/context.js';
import { saveWatchTriggerTool } from './save-watch-trigger.js';
import {
  beginWatchDeliveryTool,
  commitWatchEvaluationTool,
  listWatchDeliveryRetriesTool,
  watchExecutionTool,
} from './workflow-operations.js';

const T0 = new Date('2026-07-21T02:00:00.000Z');

const triggerInput = () => ({
  id: 't-1',
  poolId: 'pool-1',
  stockId: '002594.SZ',
  ruleKind: 'price-change' as const,
  ruleId: 'r_a',
  triggerType: 'triggered' as const,
  direction: 'watch' as const,
  priority: 'normal' as const,
  deliveryStatus: 'sent' as const,
  evalSnapshot: { ruleId: 'r_a' },
  reason: '日内涨幅 5.2%',
  evidence: ['close=15.2 prevClose=14.5'],
  quote: { close: 15.2, ts: T0 },
  notified: true,
  createdAt: T0,
});

describe('save_watch_trigger', () => {
  it('预警租约和投递工具不暴露到公共 registry，边界拒绝无效 owner', async () => {
    const names = new Set(toolRegistry.all().map((tool) => tool.name));
    for (const tool of [
      watchExecutionTool,
      commitWatchEvaluationTool,
      beginWatchDeliveryTool,
      listWatchDeliveryRetriesTool,
    ]) {
      expect(names.has(tool.name)).toBe(false);
    }
    const ctx = await buildTestContext();
    expect(await watchExecutionTool.execute({ action: 'acquire', owner: '' }, ctx)).toMatchObject({
      ok: false,
      error: { kind: 'invalid_input' },
    });
  });

  it('未持有租约不能提交任何预警触发', async () => {
    const ctx = await buildTestContext();
    expect(
      await commitWatchEvaluationTool.execute(
        {
          owner: 'not-owner',
          triggers: [triggerInput()],
          states: [],
        },
        ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'lease_lost_before_commit' } });
    expect(await ctx.repos.watchTrigger.listRecent({})).toEqual([]);
  });

  it('落库：合法 trigger → 持久化 + 字段一致', async () => {
    const ctx = await buildTestContext();
    const r = await saveWatchTriggerTool.execute(triggerInput(), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.trigger.id).toBe('t-1');

    const got = await ctx.repos.watchTrigger.findById('t-1');
    expect(got).toBeDefined();
    expect(got?.direction).toBe('watch');
    expect(got?.quote?.close).toBe(15.2);
  });

  it('quote.close <= 0 → invariant_violation', async () => {
    const ctx = await buildTestContext();
    const r = await saveWatchTriggerTool.execute(
      { ...triggerInput(), quote: { close: 0, ts: T0 } },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invariant_violation');
  });

  it('evidence 空 → invalid_input（zod 提前拦截）', async () => {
    const ctx = await buildTestContext();
    const r = await saveWatchTriggerTool.execute({ ...triggerInput(), evidence: [] }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('同 id 二次写为 upsert（覆盖 reason）', async () => {
    const ctx = await buildTestContext();
    await saveWatchTriggerTool.execute(triggerInput(), ctx);
    const r = await saveWatchTriggerTool.execute(
      { ...triggerInput(), reason: 'updated reason' },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = await ctx.repos.watchTrigger.findById('t-1');
    expect(got?.reason).toBe('updated reason');
  });
});
