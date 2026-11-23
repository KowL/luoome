import {
  STANDARD_DISCLAIMERS,
  type Strategy,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { listHoldingsTool } from '@luoome/tools';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import {
  DAILY_CANDIDATE_LIMIT,
  dailyAdviceWorkflow,
  HIGH_CONFIDENCE_THRESHOLD,
} from './daily-advice.js';

const seedStrategy = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  options: {
    readonly id: string;
    readonly score: string;
    readonly direction: 'bullish' | 'bearish';
  },
): Promise<void> => {
  const now = new Date('2026-07-28T09:00:00Z');
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: {
      logic: 'all',
      rules: [
        {
          id: 'positive-price',
          name: '价格有效',
          when: 'quote.close > 0',
          evidence: ['价格有效'],
        },
      ],
    },
    scoring: {
      method: 'weighted-sum',
      components: [{ ruleId: 'positive-price', score: '50', weight: 1 }],
    },
    signals: {
      entry: [
        {
          id: 'entry',
          name: '研究信号',
          when: 'quote.close > 0',
          score: options.score,
          direction: options.direction,
          evidence: ['仅供研究'],
        },
      ],
      exit: [],
      risk: [],
    },
  };
  const version: StrategyVersion = {
    id: `${options.id}-v1`,
    strategyId: options.id,
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  };
  const strategy: Strategy = {
    id: options.id,
    name: `测试策略 ${options.id}`,
    description: '每日判断候选池补位夹具',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.repos.strategy.create(strategy);
  await ctx.repos.strategy.createVersion(version);
};

describe('daily-advice workflow', () => {
  it('正常路径：每个活跃持仓一条建议 + 3 条 disclaimers + summary 自洽 + 信心度降序', async () => {
    const ctx = await buildTestContext();
    // 用 list_holdings 拿期望持仓数（避免直接依赖 adapters fixtures）。
    const holdingsResult = await listHoldingsTool.execute({}, ctx);
    expect(holdingsResult.ok).toBe(true);
    if (!holdingsResult.ok) return;
    const holdings = holdingsResult.data.holdings;
    expect(holdings.length).toBeGreaterThan(0);

    const result = await dailyAdviceWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { advices, summary, judgment } = result.data;
    // 活跃持仓必须全部进入判断；候选池（关注池）可能额外补充，但总数受上限约束。
    const stockIds = new Set(holdings.map((h) => h.holding.stockId));
    for (const stockId of stockIds) {
      expect(advices.some((advice) => advice.subjectId === stockId)).toBe(true);
    }
    expect(advices.length).toBeLessThanOrEqual(holdings.length + DAILY_CANDIDATE_LIMIT);

    for (const advice of advices) {
      expect(advice.subjectKind).toBe('stock');
      // 硬约束：每条 advice 恰好带 3 条 STANDARD_DISCLAIMERS。
      expect(advice.disclaimers).toEqual([...STANDARD_DISCLAIMERS]);
      expect(advice.disclaimers).toHaveLength(3);
      // 反证、风险、有效期与免责声明是 Advice 的必带内容，不能只给结论。
      expect(advice.reasoning.counterEvidence.length).toBeGreaterThan(0);
      expect(advice.risks.length).toBeGreaterThan(0);
      expect(advice.validUntil.getTime()).toBeGreaterThan(advice.validFrom.getTime());
    }

    // summary 计数自洽。
    expect(summary.total).toBe(advices.length);
    expect(summary.holdings).toBe(holdings.length);
    expect(summary.candidates).toBeLessThanOrEqual(DAILY_CANDIDATE_LIMIT);
    expect(summary.actionable).toBe(
      advices.filter((a) => a.decision === 'buy' || a.decision === 'sell').length,
    );

    // 「今日不动/今日可动」是正式结论，必须与 advices 自洽。
    if (summary.actionable === 0) {
      expect(judgment.action).toBe('今日不动');
      expect(judgment.items).toHaveLength(0);
    } else {
      expect(judgment.action).toBe('今日可动');
      expect(judgment.items).toHaveLength(summary.actionable);
    }
    expect(judgment.reason.length).toBeGreaterThan(0);
    expect(summary.highConfidence).toBe(
      advices.filter((a) => a.confidence >= HIGH_CONFIDENCE_THRESHOLD).length,
    );

    // confidence 降序。
    const confidences = advices.map((a) => a.confidence);
    expect(confidences).toEqual([...confidences].sort((a, b) => b - a));
  });

  it('显式 accountId（mock 默认账户为 uuid）路径与缺省一致', async () => {
    const ctx = await buildTestContext();
    const implicit = await dailyAdviceWorkflow.run({}, ctx);
    const explicit = await dailyAdviceWorkflow.run({ accountId: ctx.user.defaultAccountId }, ctx);
    expect(implicit.ok).toBe(true);
    expect(explicit.ok).toBe(true);
    if (!implicit.ok || !explicit.ok) return;
    expect(explicit.data.summary).toEqual(implicit.data.summary);
    expect(explicit.data.advices.map((a) => a.subjectId).sort()).toEqual(
      implicit.data.advices.map((a) => a.subjectId).sort(),
    );
  });

  it('active 策略 score ≥ 60 的看多信号补进候选池，且最多补 3 只', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx);
    await seedStrategy(ctx, { id: 'candidate-high', score: '60', direction: 'bullish' });
    const holdings = await listHoldingsTool.execute({}, ctx);
    expect(holdings.ok).toBe(true);
    if (!holdings.ok) return;
    const held = new Set(holdings.data.holdings.map((row) => row.holding.stockId));

    const result = await dailyAdviceWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { advices, summary } = result.data;
    // 策略补位上限 3，即使全市场有更多 ≥60 的看多信号。
    expect(summary.candidates).toBe(3);
    expect(advices).toHaveLength(held.size + 3);
    const candidates = advices.filter((advice) => !held.has(advice.subjectId));
    expect(candidates).toHaveLength(3);
    expect(new Set(candidates.map((advice) => advice.subjectId)).size).toBe(3);
    for (const advice of candidates) {
      expect(advice.reasoning.counterEvidence.length).toBeGreaterThan(0);
      expect(advice.risks.length).toBeGreaterThan(0);
      expect(advice.validUntil.getTime()).toBeGreaterThan(advice.validFrom.getTime());
      expect(advice.disclaimers).toEqual([...STANDARD_DISCLAIMERS]);
    }
    expect(summary.candidates).toBeLessThanOrEqual(DAILY_CANDIDATE_LIMIT);
  });

  it('score < 60 或看空信号不补进候选池', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx);
    await seedStrategy(ctx, { id: 'candidate-low', score: '59', direction: 'bullish' });
    await seedStrategy(ctx, { id: 'candidate-bearish', score: '90', direction: 'bearish' });
    const holdings = await listHoldingsTool.execute({}, ctx);
    expect(holdings.ok).toBe(true);
    if (!holdings.ok) return;

    const result = await dailyAdviceWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.summary.candidates).toBe(0);
    expect(result.data.advices).toHaveLength(holdings.data.holdings.length);
  });

  it('错误路径：accountId 非 uuid → invalid_input（run 不 throw）', async () => {
    const ctx = await buildTestContext();
    const result = await dailyAdviceWorkflow.run({ accountId: 'not-a-uuid' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('错误路径：accountId 类型错误 → invalid_input', async () => {
    const ctx = await buildTestContext();
    const result = await dailyAdviceWorkflow.run({ accountId: 123 }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('错误路径：账户不存在 → not_found 短路', async () => {
    const ctx = await buildTestContext();
    const result = await dailyAdviceWorkflow.run(
      { accountId: '00000000-0000-4000-8000-000000000000' },
      ctx,
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Account', id: '00000000-0000-4000-8000-000000000000' },
    });
  });
});
