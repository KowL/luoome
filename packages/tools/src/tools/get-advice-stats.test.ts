import { TEST_ACCOUNT } from '@luoome/adapters/testing';
import { type Advice, type AdviceRepository, STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildContext } from '../context.js';
import { buildTestContext } from '../testing/context.js';
import { getAdviceStatsTool } from './get-advice-stats.js';
import { recordAdviceOutcomeTool } from './record-advice-outcome.js';

const makeAdvice = (id: string, decision: Advice['decision'], confidence: number): Advice => ({
  id,
  subjectKind: 'stock',
  subjectId: '002594.SZ',
  decision,
  confidence,
  horizon: 'short',
  reasoning: { premise: `premise of ${id}`, evidence: [], counterEvidence: [] },
  risks: [],
  disclaimers: [...STANDARD_DISCLAIMERS],
  sourceTool: 'analyze_stock',
  basedOn: {
    dataAsOf: new Date('2026-01-01T00:00:00.000Z'),
    strategy: {
      strategyId: 'test-strategy',
      strategyVersionId: 'test-version',
      runId: 'test-run',
      stockId: '002594.SZ',
      accountId: TEST_ACCOUNT.id,
      resultEvidence: [],
      signalIds: [],
      observationIds: [],
      recommendationTrigger: 'run',
    },
  },
  validFrom: new Date('2026-01-01T00:00:00.000Z'),
  validUntil: new Date('2026-01-04T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
});

const seedTwo = (): Advice[] => [
  makeAdvice('stats-s1', 'buy', 80),
  makeAdvice('stats-s2', 'sell', 60),
];

describe('get_advice_stats', () => {
  it('正常路径：总数 / 平均信心度 / outcome 比例 / 命中率 / 按决策分解', async () => {
    const ctx = await buildTestContext({ advices: seedTwo(), adviceOutcomeOrigin: 'user' });
    const recorded = await recordAdviceOutcomeTool.execute(
      { adviceId: 'stats-s1', outcome: 'followed', pnl: 500 },
      ctx,
    );
    expect(recorded.ok).toBe(true);

    const result = await getAdviceStatsTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stats = result.data;
    expect(stats.totalAdvices).toBe(2);
    expect(stats.avgConfidence).toBe(70);
    expect(stats.outcomeRate.followed).toBe(0.5);
    expect(stats.outcomeRate.partiallyFollowed).toBe(0);
    expect(stats.outcomeRate.ignored).toBe(0);
    expect(stats.pnlWhenFollowed).toBeNull();
    expect(stats.pnlWhenIgnored).toBeNull();
    // confidence 80 >= 70 且 followed 且 pnl > 0 → 命中。
    expect(stats.hitRate).toBe(1);

    expect(stats.byDecision.buy?.totalAdvices).toBe(1);
    expect(stats.byDecision.sell?.totalAdvices).toBe(1);
    expect(stats.byDecision.hold?.totalAdvices).toBe(0);
    expect(stats.byDecision.watch?.totalAdvices).toBe(0);
    expect(stats.byDecision.avoid?.totalAdvices).toBe(0);
    expect(stats.byDecision.buy?.hitRate).toBe(1);
  });

  it('filter：subjectId 无命中 → 全零统计', async () => {
    const ctx = await buildTestContext({ advices: seedTwo(), adviceOutcomeOrigin: 'user' });
    const result = await getAdviceStatsTool.execute({ subjectId: '600519.SH' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalAdvices).toBe(0);
    expect(result.data.avgConfidence).toBe(0);
    expect(result.data.hitRate).toBeNull();
    expect(result.data.byDecision.buy?.totalAdvices).toBe(0);
  });

  it('账户统计不读取 AdviceRepository 的旧全局 outcome', async () => {
    const mockCtx = await buildTestContext({ advices: seedTwo(), adviceOutcomeOrigin: 'user' });
    const base = mockCtx.repos.advice;
    // 只通过 AdviceRepository 正式接口转发，不依赖具体 DB 实现的额外方法。
    const interfaceOnlyAdviceRepo: AdviceRepository = {
      save: (advice) => base.save(advice),
      findById: (id) => base.findById(id),
      query: (filter) => base.query(filter),
      recordOutcome: (adviceId, outcome) => base.recordOutcome(adviceId, outcome),
      findOutcome: (adviceId) => base.findOutcome(adviceId),
      listOutcomes: (filter) => base.listOutcomes(filter),
      remove: (id) => base.remove(id),
    };
    const ctx = buildContext({
      repos: { ...mockCtx.repos, advice: interfaceOnlyAdviceRepo },
      adapters: mockCtx.adapters,
      clock: mockCtx.clock,
      logger: mockCtx.logger,
      user: mockCtx.user,
    });

    const result = await getAdviceStatsTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalAdvices).toBe(2);
    expect(result.data.outcomeRate.followed).toBe(0);
    expect(result.data.hitRate).toBeNull();
  });

  it('错误路径：非法 since → invalid_input', async () => {
    const ctx = await buildTestContext({ advices: seedTwo(), adviceOutcomeOrigin: 'user' });
    const result = await getAdviceStatsTool.execute({ since: 'not-a-date' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('回填后 denominator 同步变化，并给出可解释的来源计数', async () => {
    const ctx = await buildTestContext({
      advices: seedTwo(),
      adviceOutcomeOrigin: 'user',
    });
    const before = await getAdviceStatsTool.execute({}, ctx);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.data.denominator).toBe(0);
    expect(before.data.originCounts).toEqual({ user: 0, model: 0, import: 0, unattested: 0 });
    expect(before.data.excluded).toEqual({ nonUserOrigin: 0, unattested: 0 });

    const recorded = await recordAdviceOutcomeTool.execute(
      { adviceId: 'stats-s1', outcome: 'followed', pnl: 500 },
      ctx,
    );
    expect(recorded.ok).toBe(true);

    const after = await getAdviceStatsTool.execute({}, ctx);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // 分母 +1 的来源：一条用户回填，没有别的变化。
    expect(after.data.denominator).toBe(1);
    expect(after.data.feedbackCount).toBe(1);
    expect(after.data.originCounts).toEqual({ user: 1, model: 0, import: 0, unattested: 0 });
    expect(after.data.excluded).toEqual({ nonUserOrigin: 0, unattested: 0 });
    expect(after.data.hitRate).toBe(1);
  });

  it('负例：模型代填默认不进统计，且披露被排除的条数', async () => {
    const ctx = await buildTestContext({ advices: seedTwo() });
    // 默认上下文 = agent 会话通道：脚本模型「代选」一条兑现。
    const forged = await recordAdviceOutcomeTool.execute(
      { adviceId: 'stats-s1', outcome: 'followed', pnl: 500, origin: 'user' } as never,
      ctx,
    );
    expect(forged.ok).toBe(true);
    if (!forged.ok) return;
    expect(forged.data.outcome.origin).toBe('model');

    const stats = await getAdviceStatsTool.execute({}, ctx);
    expect(stats.ok).toBe(true);
    if (!stats.ok) return;
    expect(stats.data.originFilter).toBe('user');
    expect(stats.data.denominator).toBe(0);
    expect(stats.data.feedbackCount).toBe(0);
    expect(stats.data.hitRate).toBeNull();
    expect(stats.data.outcomeRate.followed).toBe(0);
    expect(stats.data.originCounts).toEqual({ user: 0, model: 1, import: 0, unattested: 0 });
    expect(stats.data.excluded).toEqual({ nonUserOrigin: 1, unattested: 0 });
    expect(stats.data.byDecision.buy?.denominator).toBe(0);

    // 显式请求才纳入。
    const all = await getAdviceStatsTool.execute({ originFilter: 'all' }, ctx);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.originFilter).toBe('all');
    expect(all.data.denominator).toBe(1);
    expect(all.data.excluded).toEqual({ nonUserOrigin: 0, unattested: 0 });
    expect(all.data.originCounts.model).toBe(1);
  });

  it('存量无来源戳的回填单列为 unattested，不冒充用户回填', async () => {
    const ctx = await buildTestContext({ advices: seedTwo(), adviceOutcomeOrigin: 'user' });
    const recorded = await recordAdviceOutcomeTool.execute(
      { adviceId: 'stats-s2', outcome: 'ignored' },
      ctx,
    );
    expect(recorded.ok).toBe(true);
    const review = await ctx.repos.decisionReview.findBySubject({
      accountId: ctx.user.defaultAccountId,
      subject: { kind: 'advice', id: 'stats-s2' },
    });
    if (review === null) throw new Error('missing review');
    const feedback = review.revision.content.adviceFeedback;
    if (feedback === null) throw new Error('missing feedback');
    // 模拟 REQ-M3-18 之前写入的修订：adviceFeedback 没有 origin。
    const { origin: _origin, ...legacyFeedback } = feedback;
    await ctx.repos.decisionReview.commit({
      accountId: ctx.user.defaultAccountId,
      requestId: crypto.randomUUID(),
      requestHash: 'legacy-hash',
      expectedRevision: 1,
      review: review.review,
      content: { ...review.revision.content, adviceFeedback: legacyFeedback },
      contentHash: 'legacy-content-hash',
      tradeFactHashes: {},
      changeNote: '存量数据',
      recordedAt: ctx.clock(),
    });

    const stats = await getAdviceStatsTool.execute({}, ctx);
    expect(stats.ok).toBe(true);
    if (!stats.ok) return;
    expect(stats.data.denominator).toBe(0);
    expect(stats.data.originCounts.unattested).toBe(1);
    expect(stats.data.excluded).toEqual({ nonUserOrigin: 0, unattested: 1 });
  });
});
