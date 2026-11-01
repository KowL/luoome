import { testAdviceFor } from '@luoome/adapters/testing';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { deleteAdviceTool } from './delete-advice.js';
import { getAdviceTool } from './get-advice.js';

const now = new Date('2026-08-22T01:00:00.000Z');

describe('delete_advice tool', () => {
  it('批量删除：命中删除 + 未命中进 notFound，部分命中不是错误', async () => {
    const probe = await buildTestContext({ clock: () => now, advices: [] });
    const accountId = probe.user.defaultAccountId;
    const a = testAdviceFor('002594.SZ', () => now, { accountId });
    const b = testAdviceFor('600519.SH', () => now, { accountId });
    const ctx = await buildTestContext({ clock: () => now, advices: [a, b] });

    const result = await deleteAdviceTool.execute({ ids: [a.id, 'adv-missing'] }, ctx);
    // 决策 3-B：`deleted` 从「数字」改成**逐项清单**——删了哪一条必须能核对。
    if (!result.ok) throw new Error('delete failed');
    expect(result.data.deleted).toEqual([
      {
        adviceId: a.id,
        subjectKind: a.subjectKind,
        subjectId: a.subjectId,
        decision: a.decision,
        createdAt: a.createdAt,
      },
    ]);
    expect(result.data.notFound).toEqual([{ id: 'adv-missing', reason: 'not-found' }]);
    // 逐项断言同时证明：回执里**不含**建议全文（reasoning / risks）。
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain('reasoning');
    expect(serialized).not.toContain('counterEvidence');
    expect(serialized).not.toContain('risks');

    const remaining = await getAdviceTool.execute({ includeExpired: true }, ctx);
    expect(remaining.ok).toBe(true);
    if (!remaining.ok) return;
    expect(remaining.data.advices.map((advice) => advice.id)).toEqual([b.id]);
  });

  it('删除后 outcome 一并清理；全部未命中 → deleted 0', async () => {
    const probe = await buildTestContext({ clock: () => now, advices: [] });
    const a = testAdviceFor('002594.SZ', () => now, { accountId: probe.user.defaultAccountId });
    const ctx = await buildTestContext({ clock: () => now, advices: [a] });
    await ctx.repos.advice.recordOutcome(a.id, {
      adviceId: a.id,
      tradeIds: [],
      outcome: 'followed',
      recordedAt: now,
    });

    const result = await deleteAdviceTool.execute({ ids: [a.id] }, ctx);
    if (!result.ok) throw new Error('delete failed');
    expect(result.data.deleted.map((item) => item.adviceId)).toEqual([a.id]);
    expect(result.data.notFound).toEqual([]);
    expect(await ctx.repos.advice.findOutcome(a.id)).toBeNull();

    const again = await deleteAdviceTool.execute({ ids: [a.id] }, ctx);
    if (!again.ok) throw new Error('delete failed');
    expect(again.data.deleted).toEqual([]);
    expect(again.data.notFound).toEqual([{ id: a.id, reason: 'not-found' }]);
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
