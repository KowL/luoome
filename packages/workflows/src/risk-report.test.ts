import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isHoliday, isWeekend, money, type ToolContext } from '@luoome/core';
import { getPortfolioRiskTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { riskReportWorkflow } from './risk-report.js';

/**
 * `historicalVaR95` 的三条口径断言已随数学下沉到
 * `packages/tools/src/tools/portfolio-risk.test.ts` 的「纯数学：唯一实现」一组
 * （含「5 个样本默认门槛下不给数字」与「显式降低门槛后复现 3.6 百分点」）。
 * 本文件只断言 workflow 层的口径唯一性、三态透传与「刷新由 workflow 负责」。
 */

const ACCOUNT = 'acct-risk-workflow';
const NOW = new Date('2026-07-17T07:00:00.000Z');
const DAY_MS = 86_400_000;

const isTradingDay = (date: Date): boolean => !isWeekend(date) && !isHoliday(date);

/** 以 `anchor` 当日在内的 `count` 个连续交易日（升序，UTC 零点）。 */
const tradingDaysEndingAt = (anchor: Date, count: number): Date[] => {
  const days: Date[] = [];
  let cursor = new Date(`${anchor.toISOString().slice(0, 10)}T00:00:00.000Z`);
  while (days.length < count) {
    if (isTradingDay(cursor)) days.push(new Date(cursor));
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return days.reverse();
};

/** 落一条已落库绩效快照（工具唯一的 VaR 输入）。 */
const seedSnapshot = async (
  ctx: ToolContext,
  input: { readonly accountId: string; readonly returnsPct: readonly number[] },
): Promise<void> => {
  const days = tradingDaysEndingAt(NOW, input.returnsPct.length + 1);
  await ctx.repos.portfolioPerformanceSnapshot.save({
    id: `snapshot-${input.accountId}`,
    accountId: input.accountId,
    from: days[0] ?? NOW,
    to: NOW,
    currency: 'CNY',
    inputFingerprint: `fingerprint-${input.accountId}`,
    calculatedAt: new Date(NOW.getTime() - 60_000),
    performance: {
      accountId: input.accountId,
      from: days[0] ?? NOW,
      to: NOW,
      currency: 'CNY',
      completeness: 'complete',
      cashFlowComplete: true,
      benchmarkStatus: 'unavailable',
      realizedPnl: 0,
      contributions: [],
      warnings: [],
      valuation: days.map((date, index) => ({
        date,
        cash: 88_000,
        holdingsValue: 12_000,
        totalValue: 100_000,
        completeness: 'complete' as const,
        missingStockIds: [],
        externalCashFlow: 0,
        ...(index === 0 ? {} : { twrReturnPct: input.returnsPct[index - 1] ?? 0 }),
        cumulativeTwrPct: 0,
        drawdownPct: 0,
      })),
    },
  });
};

const seedPricedAccount = async (ctx: ToolContext): Promise<void> => {
  await ctx.repos.account.save({
    id: ACCOUNT,
    name: 'risk-report fixture',
    kind: 'real',
    currency: 'CNY',
    initialCapital: money(88_000),
    cashBalance: money(88_000),
    createdAt: new Date('2026-01-05T01:00:00.000Z'),
  });
  await ctx.repos.holding.save({
    id: `holding-${ACCOUNT}-601398.SH`,
    accountId: ACCOUNT,
    stockId: '601398.SH',
    quantity: 1000,
    availableQuantity: 1000,
    avgCost: money(10),
    openedAt: new Date('2026-06-01T01:00:00.000Z'),
    closedAt: null,
  });
  const observedAt = new Date(NOW.getTime() - 60_000);
  await ctx.repos.quote.save({
    stockId: '601398.SH',
    observedAt,
    fetchedAt: NOW,
    timestampSource: 'upstream',
    ts: observedAt,
    open: money(12),
    high: money(12),
    low: money(12),
    close: money(12),
    volume: 1000,
    source: 'test',
  });
};

describe('workflow/risk-report', () => {
  it('F1 指标与 get_portfolio_risk 深相等（同一实现，不是两套数学）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedPricedAccount(ctx);
    await seedSnapshot(ctx, {
      accountId: ACCOUNT,
      returnsPct: Array.from({ length: 20 }, () => -1),
    });

    const tool = await getPortfolioRiskTool.execute({ accountId: ACCOUNT }, ctx);
    const workflow = await riskReportWorkflow.run({ accountId: ACCOUNT }, ctx);
    expect(workflow.ok).toBe(true);
    expect(tool.ok).toBe(true);
    if (!workflow.ok || !tool.ok) return;

    expect(workflow.data.schemaVersion).toBe(tool.data.schemaVersion);
    // VaR 已可用 → 刷新被跳过 → 不出现「已刷新」结论（与「刷新了但样本仍不足」可区分）。
    expect(workflow.data.warnings.some((line) => line.includes('已刷新绩效快照'))).toBe(false);
    expect(workflow.data.metrics).toEqual(tool.data.metrics);
    expect(workflow.data.limitCheck).toEqual(tool.data.limitCheck);
    expect(workflow.data.coverage).toEqual(tool.data.coverage);
    expect(workflow.data.holdingsCount).toBe(tool.data.coverage.holdingsCount);
  });

  it('F1b totalValue 取总资产分母，且不重复实现 2% 之类的固定比例', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedPricedAccount(ctx);
    await seedSnapshot(ctx, {
      accountId: ACCOUNT,
      returnsPct: Array.from({ length: 20 }, () => -1),
    });

    const result = await riskReportWorkflow.run({ accountId: ACCOUNT }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 12_000 持仓 + 88_000 现金
    expect(result.data.totalValue).toBeCloseTo(100_000, 6);
    const var95 = result.data.metrics.find((metric) => metric.name === 'var95Cny');
    expect(var95).toBeDefined();
    if (var95 !== undefined && 'value' in var95) {
      expect(var95.value).not.toBeCloseTo(100_000 * 0.02, 8);
      // 20 个 -1% 收益 → 5% 分位 -1% → 金额 VaR = 1% × 100_000
      expect(var95.value).toBeCloseTo(1_000, 6);
    }
  });

  it('F3 工具 unavailable 时 workflow 同步 unavailable，且 totalValue 字段缺席而不是 0', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const accountId = 'acct-risk-workflow-unpriced';
    await ctx.repos.account.save({
      id: accountId,
      name: 'risk-report unpriced fixture',
      kind: 'real',
      currency: 'CNY',
      initialCapital: money(100_000),
      cashBalance: money(100_000),
      createdAt: new Date('2026-01-05T01:00:00.000Z'),
    });
    await ctx.repos.holding.save({
      id: `holding-${accountId}-600519.SH`,
      accountId,
      stockId: '600519.SH',
      quantity: 100,
      availableQuantity: 100,
      avgCost: money(800),
      openedAt: new Date('2026-06-01T01:00:00.000Z'),
      closedAt: null,
    });

    const result = await riskReportWorkflow.run({ accountId }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).not.toHaveProperty('totalValue');
    expect(JSON.stringify(result.data)).not.toContain('"totalValue"');
    const hhi = result.data.metrics.find((metric) => metric.name === 'concentration_hhi');
    expect(hhi).toMatchObject({ status: 'unavailable', reason: 'coverage-gap' });
    expect(hhi).not.toHaveProperty('value');
    expect(result.data.dataHealth.status).toBe('unavailable');
    expect(result.data.limitCheck.status).toBe('not-evaluated');
  });

  it('F4 新装账户（库里没有快照）跑 risk-report → 刷新后 VaR 可用；刷新在 workflow 不在工具', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedPricedAccount(ctx);

    // 1) 工具本身是纯 read：调用前后快照数不变，VaR 如实 unavailable。
    const before = await ctx.repos.portfolioPerformanceSnapshot.listByAccount(ACCOUNT);
    expect(before).toHaveLength(0);
    const toolOnly = await getPortfolioRiskTool.execute({ accountId: ACCOUNT }, ctx);
    expect(toolOnly.ok).toBe(true);
    if (!toolOnly.ok) return;
    const var95Before = toolOnly.data.metrics.find((metric) => metric.name === 'var95Pct');
    expect(var95Before).toMatchObject({ status: 'unavailable', reason: 'no-valuation-day' });
    expect(await ctx.repos.portfolioPerformanceSnapshot.listByAccount(ACCOUNT)).toHaveLength(0);

    // 2) workflow 负责刷新（external 编排），刷新后 VaR 变成 available。
    const result = await riskReportWorkflow.run({ accountId: ACCOUNT }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const var95After = result.data.metrics.find((metric) => metric.name === 'var95Pct');
    expect(var95After?.status).toBe('available');
    expect(result.data.dataHealth.unavailableMetrics).not.toContain('var95Pct');
    expect(
      (await ctx.repos.portfolioPerformanceSnapshot.listByAccount(ACCOUNT)).length,
    ).toBeGreaterThan(0);
  });

  it('F5 刷新过但样本本身不足 → warning 点名「样本本身不足」，与「没去拿数据」可区分', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    await seedPricedAccount(base);
    // 只给 3 根日线：刷新会成功落快照，但有效日收益远不到 20 个。
    const market = base.adapters.market;
    const thinMarket: typeof market = Object.assign(Object.create(market), {
      fetchDailyBars: async (
        stockCode: Parameters<typeof market.fetchDailyBars>[0],
        range: Parameters<typeof market.fetchDailyBars>[1],
      ) => (await market.fetchDailyBars(stockCode, range)).slice(-3),
    });
    const ctx: ToolContext = { ...base, adapters: { ...base.adapters, market: thinMarket } };

    const result = await riskReportWorkflow.run({ accountId: ACCOUNT }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const var95 = result.data.metrics.find((metric) => metric.name === 'var95Pct');
    expect(var95?.status).toBe('insufficient');
    if (var95?.status !== 'insufficient') return;

    const refreshWarning = result.data.warnings.find((line) => line.includes('已刷新绩效快照'));
    expect(refreshWarning, '刷新过就必须说清楚「刷新过」').toBeDefined();
    expect(refreshWarning).toContain('样本本身不足');
    expect(refreshWarning).toContain(`仍只有 ${String(var95.window?.returnsCount ?? -1)} 个`);
    expect(refreshWarning).toContain('需 ≥20');
    // 快照确实落了库：证明「不足」不是「没去拿数据」。
    expect(
      (await ctx.repos.portfolioPerformanceSnapshot.listByAccount(ACCOUNT)).length,
    ).toBeGreaterThan(0);
  });

  it('F2 口径唯一：workflow 源码不再持有本地风险数学常量', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'risk-report.ts'), 'utf8');
    // 只查代码，不查注释：注释里保留「旧实现错在哪」的说明是有价值的。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [
      'HHI_THRESHOLD',
      'historicalVaR95',
      'VAR_LOOKBACK_DAYS',
      'RiskMetricSchema = z.object',
    ]) {
      expect(code, `risk-report.ts 不该再出现 ${forbidden}`).not.toContain(forbidden);
    }
    expect(code).toContain('get_portfolio_risk');
    // 刷新是 workflow 的正当编排：external 能力只能在这里被调用。
    expect(code).toContain('get_account_performance');
  });
});
