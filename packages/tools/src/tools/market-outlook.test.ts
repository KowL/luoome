import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { marketOutlookTool } from './market-outlook.js';

describe('tool/market_outlook', () => {
  it('生成大盘观点 advice 并落库', async () => {
    const ctx = await buildTestContext();
    const r = await marketOutlookTool.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.advice.subjectKind).toBe('market');
    expect(['buy', 'sell', 'hold', 'watch', 'avoid']).toContain(r.data.advice.decision);
    expect(r.data.advice.disclaimers.length).toBeGreaterThan(0);
    expect(typeof r.data.evaluatedStocks).toBe('number');
  });

  it('theme 指定 → subjectId 包含 theme', async () => {
    const ctx = await buildTestContext();
    const r = await marketOutlookTool.execute({ theme: '新能源' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.advice.subjectId).toBe('新能源');
  });
});
