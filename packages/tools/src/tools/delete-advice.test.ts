import { testAdviceFor } from '@luoome/adapters/testing';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { deleteAdviceTool } from './delete-advice.js';
import { getAdviceTool } from './get-advice.js';

const now = new Date('2026-08-22T01:00:00.000Z');

describe('delete_advice tool', () => {
  it('批量删除：命中删除 + 未命中进 notFound，部分命中不是错误', async () => {
    const a = testAdviceFor('002594.SZ', () => now);
    const b = testAdviceFor('600519.SH', () => now);
    const ctx = await buildTestContext({ clock: () => now, advices: [a, b] });

    const result = await deleteAdviceTool.execute({ ids: [a.id, 'adv-missing'] }, ctx);
    expect(result).toEqual({ ok: true, data: { deleted: 1, notFound: ['adv-missing'] } });

    const remaining = await getAdviceTool.execute({ includeExpired: true }, ctx);
    expect(remaining.ok).toBe(true);
    if (!remaining.ok) return;
    expect(remaining.data.advices.map((advice) => advice.id)).toEqual([b.id]);
  });

  it('删除后 outcome 一并清理；全部未命中 → deleted 0', async () => {
    const a = testAdviceFor('002594.SZ', () => now);
    const ctx = await buildTestContext({ clock: () => now, advices: [a] });
    await ctx.repos.advice.recordOutcome(a.id, {
      adviceId: a.id,
      tradeIds: [],
      outcome: 'followed',
      recordedAt: now,
    });

    const result = await deleteAdviceTool.execute({ ids: [a.id] }, ctx);
    expect(result).toEqual({ ok: true, data: { deleted: 1, notFound: [] } });
    expect(await ctx.repos.advice.findOutcome(a.id)).toBeNull();

    const again = await deleteAdviceTool.execute({ ids: [a.id] }, ctx);
    expect(again).toEqual({ ok: true, data: { deleted: 0, notFound: [a.id] } });
  });

  it('输入校验：空数组 / 超上限 → invalid_input', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const empty = await deleteAdviceTool.execute({ ids: [] }, ctx);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.kind).toBe('invalid_input');

    const tooMany = await deleteAdviceTool.execute(
      { ids: Array.from({ length: 101 }, (_, i) => `adv-${i}`) },
      ctx,
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.kind).toBe('invalid_input');
  });
});
