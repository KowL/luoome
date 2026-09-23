import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { listWatchTriggersTool } from './list-watch-triggers.js';
import { saveWatchTriggerTool } from './save-watch-trigger.js';

const save = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  input: {
    id: string;
    stockId: string;
    ruleKind: 'price-change' | 'cost-threshold';
    notified: boolean;
    createdAt: Date;
  },
) =>
  saveWatchTriggerTool.execute(
    {
      ...input,
      poolId: 'holdings-watch',
      ruleId: `r_${input.id}`,
      triggerType: 'triggered',
      direction: input.ruleKind === 'cost-threshold' ? 'sell' : 'watch',
      priority: 'normal',
      deliveryStatus: input.notified ? 'sent' : 'not-requested',
      evalSnapshot: { ruleId: `r_${input.id}` },
      reason: `trigger ${input.id}`,
      evidence: ['observable evidence'],
      quote: { close: 100, ts: input.createdAt },
    },
    ctx,
  );

describe('list_watch_triggers', () => {
  it('分页不改变总数，反馈和优先级在分页前生效', async () => {
    const ctx = await buildTestContext();
    for (const id of ['a', 'b', 'c'])
      await save(ctx, {
        id,
        stockId: '002594.SZ',
        ruleKind: 'price-change',
        notified: false,
        createdAt: new Date('2026-07-23T01:00:00Z'),
      });
    await ctx.repos.watchTrigger.setFeedback('b', 'handled', ctx.clock());
    const result = await listWatchTriggersTool.execute(
      {
        includeSummary: true,
        feedback: 'unreviewed',
        priority: 'normal',
        deliveryStatus: ['not-requested'],
        offset: 1,
        limit: 1,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(2);
    expect(result.data.summary).toMatchObject({
      priorityCounts: { normal: 2 },
      feedbackCounts: {},
      stocks: [{ count: 2, latest: { id: 'c' } }],
    });
    expect(result.data.triggers.map((t) => t.id)).toEqual(['a']);
  });

  it('优先级排序透传到分页查询，默认仍按时间返回', async () => {
    const ctx = await buildTestContext();
    await save(ctx, {
      id: 'old',
      stockId: '002594.SZ',
      ruleKind: 'price-change',
      notified: false,
      createdAt: new Date('2026-07-23T01:00:00Z'),
    });
    await save(ctx, {
      id: 'new',
      stockId: '002594.SZ',
      ruleKind: 'price-change',
      notified: false,
      createdAt: new Date('2026-07-23T02:00:00Z'),
    });
    const old = await ctx.repos.watchTrigger.findById('old');
    if (!old) throw new Error('missing fixture');
    await ctx.repos.watchTrigger.save({ ...old, priority: 'urgent' });
    const priority = await listWatchTriggersTool.execute({ orderBy: 'priority', limit: 1 }, ctx);
    const recent = await listWatchTriggersTool.execute({ limit: 1 }, ctx);
    expect(priority.ok && priority.data.triggers[0]?.id).toBe('old');
    expect(recent.ok && recent.data.triggers[0]?.id).toBe('new');
  });

  it.each([
    { orderBy: 'invalid' },
    { offset: -1 },
    { offset: 0.5 },
    { priority: 'wrong' },
    { feedback: 'wrong' },
    { deliveryStatus: ['wrong'] },
  ])('拒绝无效筛选或分页 %j', async (input) => {
    const result = await listWatchTriggersTool.execute(input, await buildTestContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('按池/股票/规则/通知状态筛选并按时间倒序返回', async () => {
    const ctx = await buildTestContext();
    await save(ctx, {
      id: 'trigger-1',
      stockId: '002594.SZ',
      ruleKind: 'price-change',
      notified: true,
      createdAt: new Date('2026-07-23T01:00:00.000Z'),
    });
    await save(ctx, {
      id: 'trigger-2',
      stockId: '002594.SZ',
      ruleKind: 'cost-threshold',
      notified: false,
      createdAt: new Date('2026-07-23T02:00:00.000Z'),
    });
    await save(ctx, {
      id: 'trigger-3',
      stockId: '600519.SH',
      ruleKind: 'cost-threshold',
      notified: false,
      createdAt: new Date('2026-07-23T03:00:00.000Z'),
    });

    const result = await listWatchTriggersTool.execute(
      {
        poolId: 'holdings-watch',
        stockId: '002594.SZ',
        ruleKind: 'cost-threshold',
        ruleId: 'r_trigger-2',
        notified: false,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(1);
    expect(result.data.triggers.map((trigger) => trigger.id)).toEqual(['trigger-2']);
    expect(result.data.triggers[0]?.stockName).toBe(
      (await ctx.repos.stock.findById('002594.SZ'))?.name,
    );
  });

  it('limit 在过滤与倒序之后生效', async () => {
    const ctx = await buildTestContext();
    await save(ctx, {
      id: 'trigger-old',
      stockId: '002594.SZ',
      ruleKind: 'price-change',
      notified: true,
      createdAt: new Date('2026-07-22T01:00:00.000Z'),
    });
    await save(ctx, {
      id: 'trigger-new',
      stockId: '600519.SH',
      ruleKind: 'price-change',
      notified: true,
      createdAt: new Date('2026-07-23T01:00:00.000Z'),
    });

    const result = await listWatchTriggersTool.execute({ limit: 1 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(2);
    expect(result.data.triggers[0]?.id).toBe('trigger-new');
  });

  it('alertPlanId 过滤命中 alertPlanId，缺省回填 poolId', async () => {
    const ctx = await buildTestContext();
    const base = {
      stockId: '002594.SZ',
      ruleKind: 'price-change' as const,
      notified: true,
      createdAt: new Date('2026-07-23T01:00:00.000Z'),
    };
    // 新模型：alertPlanId 与 poolId 同值
    const saved = await saveWatchTriggerTool.execute(
      {
        id: 'trigger-plan-a',
        alertPlanId: 'plan-a',
        poolId: 'plan-a',
        ruleId: 'r_1',
        triggerType: 'triggered',
        direction: 'watch',
        priority: 'normal',
        deliveryStatus: 'sent',
        evalSnapshot: { ruleId: 'r_1' },
        reason: 'trigger plan-a',
        evidence: ['observable evidence'],
        quote: { close: 100, ts: base.createdAt },
        ...base,
      },
      ctx,
    );
    expect(saved.ok).toBe(true);
    // 迁移期旧数据：只有 poolId
    await save(ctx, { id: 'trigger-legacy', ...base });

    const byPlan = await listWatchTriggersTool.execute({ alertPlanId: 'plan-a' }, ctx);
    expect(byPlan.ok).toBe(true);
    if (!byPlan.ok) return;
    expect(byPlan.data.triggers.map((trigger) => trigger.id)).toEqual(['trigger-plan-a']);

    const legacy = await listWatchTriggersTool.execute({ alertPlanId: 'holdings-watch' }, ctx);
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.data.triggers.map((trigger) => trigger.id)).toEqual(['trigger-legacy']);
  });
});
