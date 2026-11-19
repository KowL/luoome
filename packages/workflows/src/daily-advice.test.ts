import { STANDARD_DISCLAIMERS } from '@luoome/core';
import { listHoldingsTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import {
  DAILY_CANDIDATE_LIMIT,
  dailyAdviceWorkflow,
  HIGH_CONFIDENCE_THRESHOLD,
} from './daily-advice.js';

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
