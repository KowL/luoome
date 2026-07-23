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
      direction: input.ruleKind === 'cost-threshold' ? 'sell' : 'watch',
      reason: `trigger ${input.id}`,
      evidence: ['observable evidence'],
      quote: { close: 100, ts: input.createdAt },
    },
    ctx,
  );

describe('list_watch_triggers', () => {
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
        notified: false,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(1);
    expect(result.data.triggers.map((trigger) => trigger.id)).toEqual(['trigger-2']);
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
});
