import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { closeHoldingTool } from './close-holding.js';

describe('close_holding', () => {
  it('平仓：closedAt 落当前时钟，行保留', async () => {
    const ctx = await buildTestContext();
    const result = await closeHoldingTool.execute({ holdingId: 'test-holding-002594' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holding.closedAt).not.toBeNull();

    const persisted = await ctx.repos.holding.findById('test-holding-002594');
    expect(persisted?.closedAt).not.toBeNull();
    expect(persisted?.quantity).toBe(1000); // 数量保留
  });

  it('重复平仓 → invalid_input', async () => {
    const ctx = await buildTestContext();
    const first = await closeHoldingTool.execute({ holdingId: 'test-holding-002594' }, ctx);
    expect(first.ok).toBe(true);
    const second = await closeHoldingTool.execute({ holdingId: 'test-holding-002594' }, ctx);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.kind).toBe('invalid_input');
  });

  it('持仓不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const result = await closeHoldingTool.execute({ holdingId: 'no-such' }, ctx);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Holding', id: 'no-such' },
    });
  });
});
