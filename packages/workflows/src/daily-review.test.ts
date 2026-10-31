import type {
  Advice,
  LimitUpLadder,
  LimitUpLadderDiff,
  LimitUpLadderManagerLike,
} from '@luoome/core';
import { STANDARD_DISCLAIMERS } from '@luoome/core';
import { recordAdviceOutcomeTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { dailyReviewWorkflow } from './daily-review.js';

/** 当日窗口内的组合建议：subjectKind=portfolio 时按 subjectId 归属账户。 */
const makePortfolioAdvice = (id: string, accountId: string, createdAt: string): Advice => ({
  id,
  subjectKind: 'portfolio',
  subjectId: accountId,
  decision: 'buy',
  confidence: 80,
  horizon: 'short',
  reasoning: { premise: `premise of ${id}`, evidence: [], counterEvidence: [] },
  risks: [],
  disclaimers: [...STANDARD_DISCLAIMERS],
  sourceTool: 'analyze_stock',
  basedOn: { dataAsOf: new Date(createdAt) },
  validFrom: new Date(createdAt),
  validUntil: new Date('2026-12-31T00:00:00.000Z'),
  createdAt: new Date(createdAt),
});

const mkLadderManager = (
  opts: { readonly fail?: boolean; readonly ladder?: LimitUpLadder } = {},
): LimitUpLadderManagerLike => {
  const fakeLadder: LimitUpLadder = opts.ladder ?? {
    date: '2026-07-25',
    total: 2,
    maxLevel: 3,
    source: 'eastmoney',
    levels: [
      { level: 3, name: '3 连板', count: 1, stocks: [] },
      { level: 1, name: '首板', count: 1, stocks: [] },
    ],
    warnings: [],
    asOf: new Date('2026-07-25T12:00:00Z'),
  };
  const fakePrev: LimitUpLadder = {
    date: '2026-07-24',
    total: 1,
    maxLevel: 3,
    source: 'eastmoney',
    levels: [{ level: 3, name: '3 连板', count: 1, stocks: [] }],
    warnings: [],
    asOf: new Date('2026-07-24T12:00:00Z'),
  };
  const fakeDiff: LimitUpLadderDiff = {
    totalDelta: 1,
    maxLevelDelta: 0,
    topLevelAdded: ['600519'],
    topLevelRemoved: [],
    topLevelRetained: ['000001'],
  };
  return {
    name: 'limit-up-ladder',
    sources: ['eastmoney'],
    status: () => [],
    fetchLadder: async () =>
      opts.fail === true
        ? {
            ok: false,
            error: {
              kind: 'adapter_error',
              adapter: 'limit-up-ladder',
              message: 'x',
              recoverable: false,
            },
          }
        : { ok: true, data: fakeLadder },
    compareLadder: async () =>
      opts.fail === true
        ? {
            ok: false,
            error: {
              kind: 'adapter_error',
              adapter: 'limit-up-ladder',
              message: 'x',
              recoverable: false,
            },
          }
        : { ok: true, data: { curr: fakeLadder, prev: fakePrev, diff: fakeDiff } },
  };
};

describe('daily-review workflow Phase 2 (含天梯)', () => {
  it('limitUpLadder 未注入 → ladder 为 null，summary 仍出', async () => {
    const ctx = await buildTestContext();
    const r = await dailyReviewWorkflow.run({ timezoneOffsetHours: 8 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ladder).toBeNull();
    expect(r.data.summary.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.data.summary.totalAdvices).toBeGreaterThanOrEqual(0);
  });

  it('manager 成功 → ladder 段包含 curr/prev/diff', async () => {
    const manager = mkLadderManager();
    const ctx = await buildTestContext({ limitUpLadder: manager });
    const r = await dailyReviewWorkflow.run({ timezoneOffsetHours: 8 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ladder).not.toBeNull();
    const ladder = r.data.ladder;
    if (ladder === null) return;
    expect(ladder.curr.date).toBe('2026-07-25');
    expect(ladder.prev.date).toBe('2026-07-24');
    expect(ladder.curr.total).toBe(2);
    expect(ladder.prev.total).toBe(1);
    expect(ladder.diff.totalDelta).toBe(1);
    expect(ladder.diff.topLevelAdded).toEqual(['600519']);
  });

  it('compareLadder 失败 → ladder 为 null', async () => {
    const manager = mkLadderManager({ fail: true });
    const ctx = await buildTestContext({ limitUpLadder: manager });
    const r = await dailyReviewWorkflow.run({ timezoneOffsetHours: 8 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ladder).toBeNull();
  });
});

describe('daily-review 当日命中率口径（REQ-M3-10）', () => {
  const NOW = new Date('2026-07-25T04:00:00.000Z');

  it('model 来源回填不进当日分母；分母只算 origin=user 的已了结样本', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => NOW });
    const accountId = ctx.user.defaultAccountId;
    await ctx.repos.advice.save(
      makePortfolioAdvice('dr-user', accountId, '2026-07-25T02:00:00.000Z'),
    );
    await ctx.repos.advice.save(
      makePortfolioAdvice('dr-model', accountId, '2026-07-25T03:00:00.000Z'),
    );
    const user = await recordAdviceOutcomeTool.execute(
      { adviceId: 'dr-user', accountId, outcome: 'followed', pnl: 100 },
      { ...ctx, adviceOutcomeOrigin: 'user' },
    );
    const model = await recordAdviceOutcomeTool.execute(
      { adviceId: 'dr-model', accountId, outcome: 'followed', pnl: -50 },
      { ...ctx, adviceOutcomeOrigin: 'model' },
    );
    expect(user.ok).toBe(true);
    expect(model.ok).toBe(true);

    const r = await dailyReviewWorkflow.run({ timezoneOffsetHours: 8 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 只有 user 回填进入当日口径：1 条已了结样本、命中 1 条 → 1/1。
    expect(r.data.summary.outcomeFilled).toBe(1);
    expect(r.data.summary.hits).toBe(1);
    expect(r.data.summary.denominator).toBe(1);
    expect(r.data.summary.hitRate).toBe(1);
    expect(r.data.summary.minimumSampleMet).toBe(false);
    expect(r.data.summary.metricVersion).toBe('advice-hit-rate-v3');
    // 分母与命中数同源：hitRate 必须能由 hits / denominator 复算出来。
    const hitRate = r.data.summary.hitRate ?? Number.NaN;
    expect(Math.abs(r.data.summary.hits / hitRate - r.data.summary.denominator)).toBeLessThan(1e-9);
    // model 回填被排除（若误入分母，hitRate 会变成 1/2）。
    expect(r.data.excluded.nonUserOrigin).toBe(1);
    expect(r.data.limitations.join('\n')).toContain('当日命中率按统一口径计算');
    expect(r.data.limitations.join('\n')).toContain('advice-hit-rate-v3');
  });

  it('当日没有已了结样本时 hitRate 为 null（不是 0）', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => NOW });
    const accountId = ctx.user.defaultAccountId;
    await ctx.repos.advice.save(
      makePortfolioAdvice('dr-unsettled', accountId, '2026-07-25T02:00:00.000Z'),
    );
    const rec = await recordAdviceOutcomeTool.execute(
      { adviceId: 'dr-unsettled', accountId, outcome: 'followed' },
      { ...ctx, adviceOutcomeOrigin: 'user' },
    );
    expect(rec.ok).toBe(true);

    const r = await dailyReviewWorkflow.run({ timezoneOffsetHours: 8 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.summary.hitRate).toBeNull();
    expect(r.data.summary.hits).toBe(0);
    expect(r.data.summary.denominator).toBe(0);
    expect(r.data.summary.minimumSampleMet).toBe(false);
    expect(r.data.summary.metricVersion).toBe('advice-hit-rate-v3');
    expect(r.data.summary.outcomeFilled).toBe(1);
    expect(r.data.excluded.unsettled).toBe(1);
  });
});
