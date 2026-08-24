import { type Advice, STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { recordAdviceOutcomeTool } from './record-advice-outcome.js';

describe('tool/record_advice_outcome', () => {
  it('adviceId 不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const r = await recordAdviceOutcomeTool.execute(
      { adviceId: 'nonexistent', outcome: 'followed', pnl: 100 },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('盈亏未知时保持缺省，不用 0 伪装已知结果', async () => {
    const ctx = await buildTestContext();
    const advice: Advice = {
      id: 'adv-unknown-pnl',
      subjectKind: 'stock',
      subjectId: '002594.SZ',
      decision: 'hold',
      confidence: 60,
      horizon: 'short',
      reasoning: { premise: '等待结果', evidence: ['e'], counterEvidence: [] },
      risks: ['r'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      basedOn: { dataAsOf: new Date() },
      validFrom: new Date(),
      validUntil: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    };
    await ctx.repos.advice.save(advice);

    const result = await recordAdviceOutcomeTool.execute(
      { adviceId: advice.id, outcome: 'partially_followed' },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome.pnl).toBeUndefined();
    expect((await ctx.repos.advice.findOutcome(advice.id))?.pnl).toBeUndefined();
  });

  it('advice 存在 + 关联交易 → outcome 字段完整落库', async () => {
    const ctx = await buildTestContext();
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
      {
        adviceId: 'adv-test-1',
        outcome: 'partially_followed',
        tradeIds: ['test-trade-0001'],
        pnl: 200,
        benchmarkPnl: 120,
        holdingHours: 5,
        notes: '只执行了首笔买入',
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.outcome.outcome).toBe('partially_followed');
    expect(r.data.outcome.pnl).toBe(200);
    expect(r.data.outcome.benchmarkPnl).toBe(120);
    expect(r.data.outcome.tradeIds).toEqual(['test-trade-0001']);
    expect(r.data.outcome.holdingHours).toBe(5);
    expect(r.data.outcome.notes).toBe('只执行了首笔买入');
    expect(r.data.outcome.adviceId).toBe('adv-test-1');
  });

  it('关联交易不存在或标的/账户不一致 → 拒绝', async () => {
    const ctx = await buildTestContext();
    const advice: Advice = {
      id: 'adv-test-2',
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
    await ctx.repos.advice.save(advice);

    const missing = await recordAdviceOutcomeTool.execute(
      { adviceId: advice.id, outcome: 'followed', tradeIds: ['missing-trade'] },
      ctx,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe('not_found');

    const mismatch = await recordAdviceOutcomeTool.execute(
      { adviceId: advice.id, outcome: 'followed', tradeIds: ['test-trade-0003'] },
      ctx,
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.kind).toBe('invalid_input');

    const baseTrade = await ctx.repos.trade.findById('test-trade-0001');
    expect(baseTrade).not.toBeNull();
    if (baseTrade !== null) {
      await ctx.repos.trade.save({
        ...baseTrade,
        id: 'foreign-trade',
        accountId: 'foreign-account',
      });
      const foreign = await recordAdviceOutcomeTool.execute(
        { adviceId: advice.id, outcome: 'followed', tradeIds: ['foreign-trade'] },
        ctx,
      );
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(foreign.error.kind).toBe('invalid_input');
    }
  });
});
