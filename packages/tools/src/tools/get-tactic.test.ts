import { describe, expect, it } from 'vitest';
import { buildMockContext } from '../context.js';
import { getTacticTool } from './get-tactic.js';

describe('tool/get_tactic', () => {
  it('命中：返回战法详情', async () => {
    const ctx = await buildMockContext();
    const r = await getTacticTool.execute({ tacticId: 'breakout-volume' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tactic.name).toContain('放量');
  });

  it('未命中：返回 not_found', async () => {
    const ctx = await buildMockContext();
    const r = await getTacticTool.execute({ tacticId: 'nonexistent' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });
});
