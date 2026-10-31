import { type Advice, money, quantity, STANDARD_DISCLAIMERS, type Trade } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { GetAdviceAttributionInput, getAdviceAttributionTool } from './get-advice-attribution.js';
import { getAccountPerformanceTool } from './portfolio-performance.js';

/**
 * S3 端到端：工具 → 落库 → 读回。
 *
 * 这里验的是**工具层**的三件事：
 * 1. 账户归属过滤（只返回本账户的建议）；
 * 2. 三条等式在真实仓储数据上成立（E1 在工具层再验一次）；
 * 3. `restated` 观察被**拒绝**而不是静默过滤（H8）。
 */

const NOW = new Date('2026-10-31T06:00:00.000Z');
const DAY = 86_400_000;
const ACCOUNT = 'a1b2c3d4-0001-4000-8000-000000000001';

const advice = (overrides: Partial<Advice> & { id: string }): Advice =>
  ({
    subjectKind: 'stock',
    subjectId: '600519.SH',
    decision: 'buy',
    confidence: 60,
    horizon: 'short',
    reasoning: { premise: 'p', evidence: [], counterEvidence: ['反证'] },
    risks: ['风险'],
    disclaimers: [...STANDARD_DISCLAIMERS],
    basedOn: {
      dataAsOf: new Date('2026-10-01T00:00:00.000Z'),
      strategy: {
        strategyId: 'stg-1',
        strategyVersionId: 'stg-1:v1',
        runId: 'run-1',
        stockId: '600519.SH',
        accountId: ACCOUNT,
        resultEvidence: [],
        signalIds: [],
        observationIds: [],
        recommendationTrigger: 'run',
      },
    },
    validFrom: new Date('2026-10-01T00:00:00.000Z'),
    validUntil: new Date('2026-11-30T00:00:00.000Z'),
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  }) as Advice;

const trade = (
  overrides: Partial<Trade> & Pick<Trade, 'id' | 'side' | 'quantity' | 'price' | 'executedAt'>,
): Trade =>
  ({
    accountId: ACCOUNT,
    stockId: '600519.SH',
    fee: money(0),
    createdAt: overrides.executedAt,
    ...overrides,
  }) as Trade;

/** 落一条账本 + 一条建议的关联成交 + 一张绩效快照（快照由真实工具算，保证同源）。 */
const seed = async () => {
  const ctx = await buildTestContext({ clock: () => NOW });
  await ctx.repos.account.save({
    id: ACCOUNT,
    name: 'attribution fixture',
    kind: 'real',
    currency: 'CNY',
    initialCapital: money(100_000),
    cashBalance: money(100_000),
    createdAt: new Date('2026-01-05T01:00:00.000Z'),
  });
  const buy = trade({
    id: 't-buy',
    side: 'buy',
    quantity: quantity(100),
    price: money(10),
    executedAt: new Date('2026-10-02T00:00:00.000Z'),
  });
  const sell = trade({
    id: 't-sell',
    side: 'sell',
    quantity: quantity(50),
    price: money(12),
    executedAt: new Date('2026-10-10T00:00:00.000Z'),
    adviceId: 'adv-1',
  });
  await ctx.repos.trade.save(buy);
  await ctx.repos.trade.save(sell);
  await ctx.repos.advice.save(advice({ id: 'adv-1' }));
  // 只属于另一个账户的建议（不应出现在结果里）。
  await ctx.repos.advice.save(
    advice({
      id: 'adv-other',
      basedOn: {
        dataAsOf: new Date('2026-10-01T00:00:00.000Z'),
        strategy: {
          strategyId: 'stg-2',
          strategyVersionId: 'stg-2:v1',
          runId: 'run-2',
          stockId: '600519.SH',
          accountId: 'someone-else',
          resultEvidence: [],
          signalIds: [],
          observationIds: [],
          recommendationTrigger: 'run',
        },
      },
    }),
  );
  return { ctx, buy, sell };
};

const runAttribution = async (ctx: Awaited<ReturnType<typeof seed>>['ctx'], input = {}) => {
  const result = await getAdviceAttributionTool.execute(
    GetAdviceAttributionInput.parse({ accountId: ACCOUNT, ...input }),
    ctx,
  );
  if (!result.ok) throw new Error(`attribution failed: ${JSON.stringify(result.error)}`);
  return result.data;
};

describe('S3 get_advice_attribution：工具 → 落库 → 读回', () => {
  it('只返回本账户的建议，链接到成交的那条为 traded', async () => {
    const { ctx } = await seed();
    const output = await runAttribution(ctx);
    expect(output.rows.map((row) => row.adviceId)).toEqual(['adv-1']);
    const row = output.rows[0];
    expect(row?.status).toBe('traded');
    if (row?.status !== 'traded') return;
    expect(row.tradeLinks.map((link) => link.tradeId)).toEqual(['t-sell']);
    expect(row.tradeLinks[0]?.relation).toBe('trade.adviceId');
    expect(output.metricVersion).toBe('advice-attribution-v1');
    expect(output.windowBasis).toBe('cumulative');
  });

  it('E1 在工具层再验一次：逐股已实现盈亏与账户层绩效同源', async () => {
    const { ctx } = await seed();
    // 用真实 external 工具落一张快照（与工具层同源的重放）。
    const performance = await getAccountPerformanceTool.execute(
      { accountId: ACCOUNT, from: new Date(NOW.getTime() - 60 * DAY), to: NOW },
      ctx,
    );
    expect(performance.ok).toBe(true);
    const output = await runAttribution(ctx);
    const row = output.rows[0];
    if (row?.status !== 'traded') throw new Error('expected traded');
    const stockContribution = performance.ok
      ? performance.data.contributions.find((item) => item.stockId === '600519.SH')
      : undefined;
    expect(stockContribution).toBeDefined();
    // 该股全部成交都属于这条建议 → 累计已实现与账户层逐股一致。
    if (row.contribution.status === 'unavailable') throw new Error('expected priced contribution');
    expect(row.contribution.components.realized).toBeCloseTo(
      stockContribution?.realizedPnl ?? Number.NaN,
      6,
    );
    // 头条等式成立（差值在容差内）。
    expect(output.reconciliation.status).toBe('available');
    if (output.reconciliation.status === 'available') {
      const expected =
        output.reconciliation.adviceContributionSum +
        output.reconciliation.residualSum +
        output.reconciliation.unallocatedDividends -
        output.reconciliation.cashCosts;
      expect(expected).toBeCloseTo(output.reconciliation.accountTotalPnl, 3);
    }
  });

  it('restated 观察被拒绝（invalid_input），不是静默过滤', async () => {
    const { ctx } = await seed();
    await ctx.repos.signalObservation.save({
      id: 'obs-restated',
      sourceKind: 'strategy-signal',
      sourceId: 'sig-x',
      stockId: '600519.SH',
      horizon: 't1',
      vintage: 'restated',
      status: 'complete',
      baselinePrice: money(10),
      baselineAt: new Date('2026-10-01T00:00:00.000Z'),
      closePrice: money(10.35),
      returnPct: 3.5,
      maxFavorableExcursionPct: 4.1,
      maxAdverseExcursionPct: -1.2,
      observedAt: new Date('2026-10-06T00:00:00.000Z'),
      createdAt: new Date('2026-10-06T00:00:00.000Z'),
    } as never);
    // 把该观察挂到建议的证据链上。
    await ctx.repos.advice.save(
      advice({
        id: 'adv-obs',
        basedOn: {
          dataAsOf: new Date('2026-10-01T00:00:00.000Z'),
          strategy: {
            strategyId: 'stg-3',
            strategyVersionId: 'stg-3:v1',
            runId: 'run-3',
            stockId: '600519.SH',
            accountId: ACCOUNT,
            resultEvidence: [],
            signalIds: ['sig-x'],
            observationIds: [],
            recommendationTrigger: 'run',
          },
        },
      }),
    );
    const result = await getAdviceAttributionTool.execute(
      GetAdviceAttributionInput.parse({ accountId: ACCOUNT }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect(JSON.stringify(result.error)).toContain('restated');
  });

  it('错误路径：未知账户 → not_found；from > to → invalid_input', async () => {
    const { ctx } = await seed();
    const unknown = await getAdviceAttributionTool.execute(
      GetAdviceAttributionInput.parse({ accountId: 'nope' }),
      ctx,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.kind).toBe('not_found');

    const inverted = GetAdviceAttributionInput.safeParse({
      accountId: ACCOUNT,
      from: '2026-10-31T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
    });
    expect(inverted.success).toBe(false);
  });

  it('sideEffect 是 read，且源码不碰 adapter / 不写库', async () => {
    expect(getAdviceAttributionTool.sideEffect).toBe('read');
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve(import.meta.dirname, 'get-advice-attribution.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('ctx.adapters');
    expect(code).not.toMatch(/\.save(Many)?\(/);
  });
});
