import { type Advice, money, STANDARD_DISCLAIMERS } from '@luoome/core';
import { submitAdviceFeedbackTool } from '@luoome/toolkit/tools/advice-feedback.js';
import {
  getAdviceSettlementsTool,
  settleAdvicesTool,
} from '@luoome/toolkit/tools/settle-advices.js';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';

const makeAdvice = (id: string, decision: Advice['decision'], createdAt: Date): Advice => ({
  id,
  subjectKind: 'stock',
  subjectId: '002594.SZ',
  decision,
  confidence: 60,
  horizon: 'short',
  entryPriceLow: money(99),
  entryPriceHigh: money(101),
  targetPrice: money(110),
  stopLoss: money(95),
  reasoning: { premise: 'premise', evidence: [], counterEvidence: [] },
  risks: [],
  disclaimers: [...STANDARD_DISCLAIMERS],
  sourceTool: 'analyze_stock',
  basedOn: { dataAsOf: createdAt },
  validFrom: createdAt,
  validUntil: new Date(createdAt.getTime() + 3 * 86_400_000),
  createdAt,
});

const bar = (stockId: string, day: number, close: number) => ({
  stockId,
  date: new Date(Date.UTC(2026, 10, day)),
  open: money(close),
  high: money(close),
  low: money(close),
  close: money(close),
  volume: 1000,
  adjustment: 'qfq' as const,
  source: 'test',
});

describe('submit_advice_feedback', () => {
  it('建议不存在 → not_found', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const result = await submitAdviceFeedbackTool.execute(
      { adviceId: 'missing', action: 'done' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
  });

  it('同一建议只保留最后一次动作，可带实际成交价', async () => {
    const createdAt = new Date('2026-11-10T09:00:00.000Z');
    const ctx = await buildTestContext({ advices: [] });
    await ctx.repos.advice.save(makeAdvice('adv-fb', 'buy', createdAt));

    await submitAdviceFeedbackTool.execute({ adviceId: 'adv-fb', action: 'later' }, ctx);
    const second = await submitAdviceFeedbackTool.execute(
      { adviceId: 'adv-fb', action: 'done', fillPrice: 100.5 },
      ctx,
    );
    expect(second.ok).toBe(true);

    const read = await getAdviceSettlementsTool.execute({ adviceId: 'adv-fb' }, ctx);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.data.feedback?.action).toBe('done');
    expect(read.data.feedback?.fillPrice).toBe(100.5);
  });
});

describe('settle_advices', () => {
  it('缺少日线时跳过，不写假结算', async () => {
    const ctx = await buildTestContext({ advices: [] });
    await ctx.repos.advice.save(makeAdvice('adv-no-bars', 'buy', new Date('2026-11-10T09:00:00Z')));
    const result = await settleAdvicesTool.execute(
      { asOf: new Date('2026-11-20T09:00:00.000Z') },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.settled).toBe(0);
    expect(result.data.skipped).toBeGreaterThan(0);
  });

  it('按 T+1/T+3/T+5 结算收益、超额与命中（buy 上涨即命中）', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const createdAt = new Date('2026-11-10T09:00:00.000Z');
    await ctx.repos.advice.save(makeAdvice('adv-ok', 'buy', createdAt));
    await ctx.repos.dailyBar.saveMany([
      bar('002594.SZ', 11, 101),
      bar('002594.SZ', 12, 102),
      bar('002594.SZ', 13, 103),
      bar('002594.SZ', 14, 104),
      bar('002594.SZ', 17, 105),
      bar('000300.SH', 11, 4000),
      bar('000300.SH', 12, 4010),
      bar('000300.SH', 13, 4020),
      bar('000300.SH', 14, 4030),
      bar('000300.SH', 17, 4050),
    ]);

    const result = await settleAdvicesTool.execute(
      { asOf: new Date('2026-11-20T09:00:00.000Z'), limit: 100 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const read = await getAdviceSettlementsTool.execute({ adviceId: 'adv-ok' }, ctx);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const byHorizon = new Map(read.data.settlements.map((s) => [s.horizonDays, s]));
    expect([...byHorizon.keys()].sort()).toEqual([1, 3, 5]);

    const day5 = byHorizon.get(5);
    expect(day5?.exitPrice).toBe(105);
    expect(day5?.assumedEntryPrice).toBe(100);
    expect(day5?.hit).toBe(true);
    expect(day5?.returnPct).toBeCloseTo(0.05, 6);
    expect(day5?.benchmarkReturnPct).toBeCloseTo(0.0125, 6);
    expect(day5?.excessPct).toBeCloseTo(0.0375, 6);
  });

  it('avoid 方向相反：下跌才算命中', async () => {
    const ctx = await buildTestContext({ advices: [] });
    await ctx.repos.advice.save(makeAdvice('adv-avoid', 'avoid', new Date('2026-11-10T09:00:00Z')));
    await ctx.repos.dailyBar.saveMany([
      bar('002594.SZ', 11, 99),
      bar('002594.SZ', 13, 98),
      bar('002594.SZ', 17, 97),
      bar('000300.SH', 11, 4000),
      bar('000300.SH', 13, 4000),
      bar('000300.SH', 17, 4000),
    ]);
    await settleAdvicesTool.execute(
      { asOf: new Date('2026-11-20T09:00:00.000Z'), limit: 100 },
      ctx,
    );
    const read = await getAdviceSettlementsTool.execute({ adviceId: 'adv-avoid' }, ctx);
    if (!read.ok) throw new Error('read failed');
    expect(read.data.settlements.length).toBeGreaterThan(0);
    for (const settlement of read.data.settlements) expect(settlement.hit).toBe(true);
  });
});
