import { type Advice, STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { recordAdviceOutcomeTool } from './record-advice-outcome.js';

const seedAdvice = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  id: string,
): Promise<void> => {
  await ctx.repos.advice.save({
    id,
    subjectKind: 'stock',
    subjectId: '002594.SZ',
    decision: 'buy',
    confidence: 70,
    horizon: 'short',
    reasoning: { premise: 'p', evidence: ['e'], counterEvidence: [] },
    risks: ['r'],
    disclaimers: [...STANDARD_DISCLAIMERS],
    sourceTool: 'analyze_stock',
    basedOn: { dataAsOf: new Date('2026-04-01T00:00:00Z') },
    validFrom: new Date('2026-04-01T00:00:00Z'),
    validUntil: new Date('2026-05-10T00:00:00Z'),
    createdAt: new Date('2026-04-01T00:00:00Z'),
  });
};

const storedFeedback = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  adviceId: string,
) =>
  (
    await ctx.repos.decisionReview.findBySubject({
      accountId: ctx.user.defaultAccountId,
      subject: { kind: 'advice', id: adviceId },
    })
  )?.revision.content.adviceFeedback ?? null;

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
      basedOn: { dataAsOf: new Date('2026-04-01T00:00:00Z') },
      validFrom: new Date('2026-04-01T00:00:00Z'),
      validUntil: new Date('2026-05-10T00:00:00Z'),
      createdAt: new Date('2026-04-01T00:00:00Z'),
    };
    await ctx.repos.advice.save(advice);

    const result = await recordAdviceOutcomeTool.execute(
      { adviceId: advice.id, outcome: 'partially_followed' },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome.pnl).toBeUndefined();
    expect(await ctx.repos.advice.findOutcome(advice.id)).toBeNull();
    expect(
      (
        await ctx.repos.decisionReview.findBySubject({
          accountId: ctx.user.defaultAccountId,
          subject: { kind: 'advice', id: advice.id },
        })
      )?.revision.content.adviceFeedback?.pnl,
    ).toBeUndefined();
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
      basedOn: { dataAsOf: new Date('2026-04-01T00:00:00Z') },
      validFrom: new Date('2026-04-01T00:00:00Z'),
      validUntil: new Date('2026-05-10T00:00:00Z'),
      createdAt: new Date('2026-04-01T00:00:00Z'),
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
      basedOn: { dataAsOf: new Date('2026-04-01T00:00:00Z') },
      validFrom: new Date('2026-04-01T00:00:00Z'),
      validUntil: new Date('2026-05-10T00:00:00Z'),
      createdAt: new Date('2026-04-01T00:00:00Z'),
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
      if (!foreign.ok) expect(foreign.error.kind).toBe('permission_denied');
    }
  });

  it('来源由通道决定：调用方传 origin=user 也只会落成 model', async () => {
    const ctx = await buildTestContext();
    await seedAdvice(ctx, 'adv-origin-forge');
    // 模拟脚本模型「代选」：参数里硬塞 origin=user。
    const result = await recordAdviceOutcomeTool.execute(
      { adviceId: 'adv-origin-forge', outcome: 'followed', pnl: 500, origin: 'user' } as never,
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome.origin).toBe('model');
    expect((await storedFeedback(ctx, 'adv-origin-forge'))?.origin).toBe('model');
  });

  it('用户亲自操作的通道才盖章 user', async () => {
    const ctx = await buildTestContext({ adviceOutcomeOrigin: 'user' });
    await seedAdvice(ctx, 'adv-origin-user');
    const result = await recordAdviceOutcomeTool.execute(
      { adviceId: 'adv-origin-user', outcome: 'partially_followed' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome.origin).toBe('user');
    expect((await storedFeedback(ctx, 'adv-origin-user'))?.origin).toBe('user');
  });

  it('回填只写 DecisionReview，不写 trades 与旧的 advice_outcomes 表', async () => {
    const ctx = await buildTestContext();
    await seedAdvice(ctx, 'adv-separate-tables');
    const tradesBefore = await ctx.repos.trade.listByAccount(ctx.user.defaultAccountId);
    const result = await recordAdviceOutcomeTool.execute(
      { adviceId: 'adv-separate-tables', outcome: 'ignored' },
      ctx,
    );
    expect(result.ok).toBe(true);
    const tradesAfter = await ctx.repos.trade.listByAccount(ctx.user.defaultAccountId);
    expect(tradesAfter.map((trade) => trade.id)).toEqual(tradesBefore.map((trade) => trade.id));
    expect(await ctx.repos.advice.findOutcome('adv-separate-tables')).toBeNull();
    expect(
      (
        await ctx.repos.decisionReview.findBySubject({
          accountId: ctx.user.defaultAccountId,
          subject: { kind: 'advice', id: 'adv-separate-tables' },
        })
      )?.revision.content.adviceFeedback,
    ).toMatchObject({ outcome: 'ignored', origin: 'model' });
  });

  it('「不知道」不是可写入的 outcome：用户不知道时不该产生样本', async () => {
    const ctx = await buildTestContext();
    await seedAdvice(ctx, 'adv-unknown-answer');
    const result = await recordAdviceOutcomeTool.execute(
      { adviceId: 'adv-unknown-answer', outcome: 'unknown' } as never,
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect(await storedFeedback(ctx, 'adv-unknown-answer')).toBeNull();
  });
});
