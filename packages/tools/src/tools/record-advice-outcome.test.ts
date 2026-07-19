import { type Advice, STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildMockContext } from '../context.js';
import { recordAdviceOutcomeTool } from './record-advice-outcome.js';

describe('tool/record_advice_outcome', () => {
  it('adviceId 不存在 → not_found', async () => {
    const ctx = await buildMockContext();
    const r = await recordAdviceOutcomeTool.execute(
      { adviceId: 'nonexistent', followed: true, pnl: 100 },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('advice 存在 + 跟单盈利 → outcome.followed + pnl 落库', async () => {
    const ctx = await buildMockContext();
    // 直接灌入一条 advice 到 advice repo
    const adv: Advice = {
      id: 'adv-test-1',
      subjectKind: 'stock',
      subjectId: '002594.SZ',
      decision: 'buy',
      confidence: 70,
      horizon: 'short',
      reasoning: { premise: 'p', evidence: ['e'], counterEvidence: [] },
      risks: ['r'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_stock',
      basedOn: { dataAsOf: new Date() },
      validFrom: new Date(),
      validUntil: new Date(Date.now() + 86400000),
      createdAt: new Date(),
    };
    await ctx.repos.advice.save(adv);

    const r = await recordAdviceOutcomeTool.execute(
      { adviceId: 'adv-test-1', followed: true, pnl: 200, holdingHours: 5 },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.outcome.outcome).toBe('followed');
    expect(r.data.outcome.pnl).toBe(200);
    expect(r.data.outcome.adviceId).toBe('adv-test-1');
  });
});
