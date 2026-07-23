import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { listTacticsTool } from './list-tactics.js';

describe('tool/list_tactics', () => {
  it('返回 5 个内置战法（默认 includeBuiltins=true）', async () => {
    const ctx = await buildTestContext();
    const r = await listTacticsTool.execute({ filter: undefined, includeBuiltins: true }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tactics.length).toBeGreaterThanOrEqual(5);
    expect(r.data.tactics.map((t) => t.id)).toContain('breakout-volume');
    expect(r.data.tactics.every((t) => t.source === 'builtin')).toBe(true);
  });

  it('tag 过滤', async () => {
    const ctx = await buildTestContext();
    const r = await listTacticsTool.execute(
      { filter: { tag: 'momentum' }, includeBuiltins: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tactics.every((t) => t.tag === 'momentum')).toBe(true);
  });
});
