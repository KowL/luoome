import { type Advice, AdviceSettlementSchema, money, STANDARD_DISCLAIMERS } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { reportWorkflow } from './report.js';
import { weeklyReportOperation } from './weekly-report.js';

const MONDAY_NOON = new Date('2026-11-16T04:00:00Z'); // 12:00 上海，周一

const context = async () =>
  buildTestContext({
    clock: () => MONDAY_NOON,
  });

const makeAdvice = (id: string, confidence: number, createdAt: Date): Advice => ({
  id,
  subjectKind: 'stock',
  subjectId: '002594.SZ',
  decision: 'buy',
  confidence,
  horizon: 'short',
  entryPriceLow: money(99),
  entryPriceHigh: money(101),
  reasoning: { premise: 'premise', evidence: [], counterEvidence: [] },
  risks: [],
  disclaimers: [...STANDARD_DISCLAIMERS],
  sourceTool: 'analyze_stock',
  basedOn: { dataAsOf: createdAt },
  validFrom: createdAt,
  validUntil: new Date(createdAt.getTime() + 3 * 86_400_000),
  createdAt,
});

const settlement = (adviceId: string, hit: boolean, excessPct: number, evaluatedAt: Date) =>
  AdviceSettlementSchema.parse({
    adviceId,
    horizonDays: 5,
    assumedEntryPrice: money(100),
    exitPrice: money(hit ? 105 : 98),
    returnPct: hit ? 0.05 : -0.02,
    benchmarkReturnPct: 0.01,
    excessPct,
    hit,
    evaluatedAt,
  });

describe('weekly-report 成绩单', () => {
  it('生成每周成绩单：只含成绩单相关 section，模板与周期正确', async () => {
    const ctx = await context();
    const result = await weeklyReportOperation.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { report, created, notified } = result.data;
    expect(created).toBe(true);
    expect(notified).toBe(false);
    expect(report.kind).toBe('weekly');
    // 周一生成回顾上一周（11-09 至 11-13）
    expect(report.periodStart).toBe('2026-11-09');
    expect(report.periodEnd).toBe('2026-11-13');
    expect(report.sections.map((section) => section.key)).toEqual([
      'advice-scorecard',
      'stock-brief-score',
      'advice-week',
      'advice-feedback',
    ]);
  });

  it('没有已结算样本时成绩单标 unavailable，门禁给出样本不足的原因', async () => {
    const ctx = await context();
    const result = await weeklyReportOperation.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scorecard = result.data.report.sections.find((s) => s.key === 'advice-scorecard');
    expect(scorecard?.status).toBe('unavailable');
    expect(scorecard?.missingDimensions.map((m) => m.dimension)).toContain(
      'advice-scorecard.settlement',
    );
    const texts = (scorecard?.blocks ?? []).flatMap((block) =>
      block.kind === 'text' ? [block.text] : [],
    );
    expect(texts.join('\n')).toContain('不足');
  });

  it('同一周期重复运行不新建报告', async () => {
    const ctx = await context();
    const first = await weeklyReportOperation.run({}, ctx);
    const second = await weeklyReportOperation.run({}, ctx);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.created).toBe(true);
    expect(second.data.created).toBe(false);
    expect(second.data.report.id).toBe(first.data.report.id);
  });

  it('非交易日直接拒绝，不生成报告', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-11-15T04:00:00Z') });
    const result = await weeklyReportOperation.run({}, ctx);
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(await ctx.repos.report.list()).toEqual([]);
  });

  it('reportWorkflow 只接受 weekly，并转交同一套生成逻辑', async () => {
    const ctx = await context();
    const result = await reportWorkflow.run({ kind: 'weekly' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { report: { kind: string } }).report.kind).toBe('weekly');
  });
});

describe('weekly-report 个股观察成绩', () => {
  const sectionOf = (result: Awaited<ReturnType<typeof weeklyReportOperation.run>>) => {
    expect(result.ok).toBe(true);
    if (!result.ok) return undefined;
    return result.data.report.sections.find((section) => section.key === 'stock-brief-score');
  };

  const textsOf = (section: { blocks: ReadonlyArray<{ kind: string; text?: string }> }) =>
    section.blocks.flatMap((block) => (block.kind === 'text' ? [block.text ?? ''] : []));

  it('没有已结算观察时标 unavailable，并给出可读原因与免责声明', async () => {
    const ctx = await context();
    const section = sectionOf(await weeklyReportOperation.run({}, ctx));
    expect(section?.title).toBe('个股观察成绩');
    expect(section?.status).toBe('unavailable');
    expect(section?.missingDimensions.map((item) => item.dimension)).toContain(
      'stock-brief-score.settlement',
    );
    const text = textsOf(section ?? { blocks: [] }).join('\n');
    expect(text).toContain('没有已结算的观察样本');
    expect(text).toContain('应结算 0 条');
    expect(text).toContain('不构成投资建议');
    expect(text).not.toMatch(/建仓|加仓|减仓|清仓|买入|卖出|满仓/);
  });

  it('规则观察不计入分母，单列条数，与成绩单口径一致', async () => {
    const ctx = await context();
    const now = ctx.clock();
    const createdAt = new Date(now.getTime() - 2 * 86_400_000);
    await ctx.repos.advice.save(makeAdvice('brief-normal-a', 70, createdAt));
    await ctx.repos.advice.save(makeAdvice('brief-normal-b', 40, createdAt));
    const fallback: Advice = {
      ...makeAdvice('brief-fallback', 30, createdAt),
      reasoning: {
        premise: 'LLM 推理不可用，基于规则的保守判断',
        evidence: ['规则 fallback：测试夹具'],
        counterEvidence: [],
      },
    };
    await ctx.repos.advice.save(fallback);
    const fallbackWatch: Advice = {
      ...makeAdvice('brief-fallback-watch', 30, createdAt),
      decision: 'watch',
      reasoning: {
        premise: 'LLM 推理不可用，基于规则的保守判断',
        evidence: ['规则 fallback：测试夹具'],
        counterEvidence: [],
      },
    };
    await ctx.repos.advice.save(fallbackWatch);
    await ctx.repos.adviceTracking.saveSettlement(settlement('brief-normal-a', true, 0.04, now));
    await ctx.repos.adviceTracking.saveSettlement(settlement('brief-normal-b', false, -0.02, now));
    await ctx.repos.adviceTracking.saveSettlement(settlement('brief-fallback', true, 0.06, now));
    await ctx.repos.adviceTracking.saveSettlement(
      settlement('brief-fallback-watch', true, 0.01, now),
    );

    const result = await weeklyReportOperation.run({}, ctx);
    const section = sectionOf(result);
    expect(section?.status).toBe('complete');
    const metrics = (section?.blocks ?? []).flatMap((block) =>
      block.kind === 'metrics' ? block.items : [],
    );
    const byKey = Object.fromEntries(metrics.map((item) => [item.key, item.value]));
    expect(byKey.samples).toBe(2);
    expect(byKey.ruleFallbackSamples).toBe(2);
    expect(byKey.ruleFallbackTotal).toBe(2);
    expect(byKey.coverage).toBe(100);
    expect(byKey.eligible).toBe(2);
    expect(byKey.settledEligible).toBe(2);
    expect(byKey.hitRate).toBe(50);
    const sectionText = textsOf(section ?? { blocks: [] }).join('\n');
    expect(sectionText).toContain('结算覆盖率 100.0%');
    expect(sectionText).toContain('规则观察（低置信）2 条、已结算 2 条');

    // 与同一窗口的成绩单同一口径。
    if (!result.ok) return;
    const scorecard = result.data.report.sections.find((item) => item.key === 'advice-scorecard');
    const scorecardMetrics = (scorecard?.blocks ?? []).flatMap((block) =>
      block.kind === 'metrics' ? block.items : [],
    );
    const scorecardByKey = Object.fromEntries(
      scorecardMetrics.map((item) => [item.key, item.value]),
    );
    expect(scorecardByKey.samples).toBe(byKey.samples);
    expect(scorecardByKey.hitRate).toBe(byKey.hitRate);
  });

  it('生成周报不调用 LLM / 行情，也不触发生成 brief', async () => {
    const base = await context();
    const calls = { llm: 0, market: 0 };
    const llm = {
      name: base.adapters.llm.name,
      generate: async () => {
        calls.llm += 1;
        throw new Error('weekly report must not call llm');
      },
    };
    const market = new Proxy(base.adapters.market, {
      get: (target, prop) => {
        const value = Reflect.get(target, prop);
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            calls.market += 1;
            return (value as (...inner: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });
    const result = await weeklyReportOperation.run({}, {
      ...base,
      adapters: { ...base.adapters, llm, market },
    } as typeof base);
    expect(result.ok).toBe(true);
    expect(calls.llm).toBe(0);
    expect(calls.market).toBe(0);
  });
});
