import { TEST_ACCOUNT, TEST_ACCOUNT_LONGTERM } from '@luoome/adapters/testing';
import { type Advice, type AdviceRepository, STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildContext } from '../context.js';
import { buildTestContext } from '../testing/context.js';
import { getAdviceStatsTool } from './get-advice-stats.js';
import { getConfidenceCalibrationTool } from './get-confidence-calibration.js';
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
  it('M3-10：同账户窗口的混合回填在两个真实工具中使用相同已了结分母', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => new Date('2026-01-05') });
    const samples = [
      { id: 'profit', outcome: 'followed', origin: 'user', pnl: 10, benchmarkPnl: 5 },
      { id: 'loss', outcome: 'followed', origin: 'user', pnl: -5, benchmarkPnl: -10 },
      { id: 'zero', outcome: 'followed', origin: 'user', pnl: 0, benchmarkPnl: 0 },
      { id: 'unclosed', outcome: 'followed', origin: 'user' },
      { id: 'partial', outcome: 'partially_followed', origin: 'user', pnl: 100 },
      { id: 'ignored', outcome: 'ignored', origin: 'user', pnl: 100 },
      { id: 'model', outcome: 'followed', origin: 'model', pnl: 100 },
      { id: 'import', outcome: 'followed', origin: 'import', pnl: 100 },
      { id: 'legacy', outcome: 'followed', origin: undefined, pnl: 100 },
      { id: 'before', outcome: 'followed', origin: 'model', pnl: 100 },
      { id: 'after', outcome: 'followed', origin: undefined, pnl: 100 },
      { id: 'other-account', outcome: 'followed', origin: 'model', pnl: 100 },
    ] as const;
    for (const sample of samples) {
      const { id, origin, ...input } = sample;
      const accountId = id === 'other-account' ? TEST_ACCOUNT_LONGTERM.id : TEST_ACCOUNT.id;
      const createdAt = new Date(
        id === 'before' ? '2025-12-31' : id === 'after' ? '2026-01-02' : '2026-01-01',
      );
      await ctx.repos.advice.save({
        ...makeAdvice(id, 'buy', 80),
        subjectKind: 'portfolio',
        subjectId: accountId,
        createdAt,
      });
      const recorded = await recordAdviceOutcomeTool.execute(
        { ...input, adviceId: id, accountId },
        { ...ctx, adviceOutcomeOrigin: origin ?? 'user' },
      );
      expect(recorded.ok).toBe(true);
      if (origin === undefined) {
        const row = await ctx.repos.decisionReview.findBySubject({
          accountId,
          subject: { kind: 'advice', id },
        });
        if (!row?.revision.content.adviceFeedback) throw new Error('missing fixture feedback');
        const { origin: _origin, ...legacy } = row.revision.content.adviceFeedback;
        await ctx.repos.decisionReview.commit({
          accountId,
          requestId: crypto.randomUUID(),
          requestHash: `legacy-${id}`,
          expectedRevision: row.review.currentRevision,
          review: row.review,
          content: { ...row.revision.content, adviceFeedback: legacy },
          contentHash: `legacy-content-${id}`,
          tradeFactHashes: {},
          changeNote: 'fixture: pre-origin revision',
          recordedAt: ctx.clock(),
        });
      }
    }
    await ctx.repos.advice.save(makeAdvice('no-feedback', 'buy', 80));
    const window = { accountId: TEST_ACCOUNT.id, since: '2026-01-01', until: '2026-01-01' };
    const stats = await getAdviceStatsTool.execute(window, ctx);
    const calibration = await getConfidenceCalibrationTool.execute(window, ctx);
    if (!stats.ok || !calibration.ok) throw new Error('fixture tools failed');
    expect(stats.data.denominator).toBe(3);
    for (const data of [stats.data, calibration.data]) {
      expect(data).toMatchObject({
        schemaVersion: 2,
        metricVersion: 'advice-hit-rate-v3',
        denominator: 3,
        hitRate: 1 / 3,
        hits: 1,
        minimumSampleMet: false,
        sampleStatus: 'insufficient',
        originCounts: { user: 6, model: 1, import: 1, unattested: 1 },
        excluded: {
          nonUserOrigin: 2,
          unattested: 1,
          unsettled: 1,
          partiallyFollowed: 1,
          ignored: 1,
        },
        excessHitRate: {
          status: 'available',
          value: 2 / 3,
          denominator: 3,
          hits: 2,
          missingBenchmark: 0,
        },
      });
    }
    expect(stats.data.feedbackCount).toBe(6);
    expect(calibration.data.overallHitRate).toBe(stats.data.hitRate);
    expect(stats.data.byDecision.buy).toMatchObject({ hitRate: null, minimumSampleMet: false });
    const allStats = await getAdviceStatsTool.execute({ ...window, originFilter: 'all' }, ctx);
    const allCalibration = await getConfidenceCalibrationTool.execute(
      { ...window, originFilter: 'all' },
      ctx,
    );
    if (!allStats.ok || !allCalibration.ok) throw new Error('fixture all tools failed');
    for (const data of [allStats.data, allCalibration.data]) {
      expect(data).toMatchObject({
        denominator: 6,
        hitRate: 4 / 6,
        excluded: {
          nonUserOrigin: 0,
          unattested: 0,
          unsettled: 1,
          partiallyFollowed: 1,
          ignored: 1,
        },
        excessHitRate: { status: 'unavailable', value: null, denominator: 3, missingBenchmark: 3 },
      });
    }
  });

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
    // 顶层保留采样描述，决策分组不足 20 条时不提供比例结论。
    expect(stats.hitRate).toBe(1);

    expect(stats.byDecision.buy?.totalAdvices).toBe(1);
    expect(stats.byDecision.sell?.totalAdvices).toBe(1);
    expect(stats.byDecision.hold?.totalAdvices).toBe(0);
    expect(stats.byDecision.watch?.totalAdvices).toBe(0);
    expect(stats.byDecision.avoid?.totalAdvices).toBe(0);
    expect(stats.byDecision.buy?.hitRate).toBeNull();
    expect(stats.byDecision.buy?.sampleStatus).toBe('insufficient');
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
    expect(before.data.excluded).toEqual({
      nonUserOrigin: 0,
      unattested: 0,
      unsettled: 0,
      partiallyFollowed: 0,
      ignored: 0,
    });

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
    expect(after.data.excluded).toEqual({
      nonUserOrigin: 0,
      unattested: 0,
      unsettled: 0,
      partiallyFollowed: 0,
      ignored: 0,
    });
    expect(after.data.excessHitRate).toMatchObject({
      status: 'unavailable',
      value: null,
      denominator: 0,
      missingBenchmark: 1,
    });
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
    expect(stats.data.excluded).toEqual({
      nonUserOrigin: 1,
      unattested: 0,
      unsettled: 0,
      partiallyFollowed: 0,
      ignored: 0,
    });
    expect(stats.data.byDecision.buy?.denominator).toBe(0);

    // 显式请求才纳入。
    const all = await getAdviceStatsTool.execute({ originFilter: 'all' }, ctx);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.originFilter).toBe('all');
    expect(all.data.denominator).toBe(1);
    expect(all.data.excluded).toEqual({
      nonUserOrigin: 0,
      unattested: 0,
      unsettled: 0,
      partiallyFollowed: 0,
      ignored: 0,
    });
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
    expect(stats.data.excluded).toEqual({
      nonUserOrigin: 0,
      unattested: 1,
      unsettled: 0,
      partiallyFollowed: 0,
      ignored: 0,
    });
  });

  it('M3-10：19 条拒绝所有分组结论，20 条使用 Wilson 手算锚点；缺一条基准也 unavailable', async () => {
    const ctx = await buildTestContext({
      advices: [],
      adviceOutcomeOrigin: 'user',
      clock: () => new Date('2026-01-05'),
    });
    for (let i = 0; i < 19; i++) {
      const id = `wilson-${i}`;
      await ctx.repos.advice.save(makeAdvice(id, 'buy', 80));
      expect(
        (
          await recordAdviceOutcomeTool.execute(
            {
              adviceId: id,
              outcome: 'followed',
              pnl: i < 10 ? 10 : -10,
              benchmarkPnl: i < 5 ? 0 : 20,
            },
            ctx,
          )
        ).ok,
      ).toBe(true);
    }
    const smallStats = await getAdviceStatsTool.execute({}, ctx);
    const smallCalibration = await getConfidenceCalibrationTool.execute({}, ctx);
    if (!smallStats.ok || !smallCalibration.ok) throw new Error('small fixture tools failed');
    for (const data of [smallStats.data, smallCalibration.data]) {
      expect(data).toMatchObject({
        denominator: 19,
        hitRate: 10 / 19,
        minimumSampleMet: false,
        sampleStatus: 'insufficient',
      });
    }
    const smallGroups = [
      smallStats.data.byDecision.buy,
      smallCalibration.data.groups[0],
      smallCalibration.data.buckets[8],
      smallCalibration.data.groups[0]?.buckets[8],
    ];
    for (const group of smallGroups) {
      expect(group).toMatchObject({
        denominator: 19,
        hits: 10,
        hitRate: null,
        confidenceInterval: null,
        minimumSampleMet: false,
        sampleStatus: 'insufficient',
        excessHitRate: { status: 'insufficient', value: null, hits: 5, denominator: 19 },
      });
    }
    await ctx.repos.advice.save(makeAdvice('wilson-19', 'buy', 80));
    expect(
      (
        await recordAdviceOutcomeTool.execute(
          { adviceId: 'wilson-19', outcome: 'followed', pnl: -10, benchmarkPnl: 20 },
          ctx,
        )
      ).ok,
    ).toBe(true);
    const stats = await getAdviceStatsTool.execute({}, ctx);
    const calibration = await getConfidenceCalibrationTool.execute({}, ctx);
    if (!stats.ok || !calibration.ok) throw new Error('Wilson fixture tools failed');
    for (const data of [
      stats.data,
      calibration.data,
      stats.data.byDecision.buy,
      calibration.data.groups[0],
      calibration.data.buckets[8],
    ]) {
      expect(data).toMatchObject({
        denominator: 20,
        hitRate: 0.5,
        minimumSampleMet: true,
        sampleStatus: 'sufficient',
        excessHitRate: { status: 'available', value: 0.25, denominator: 20, missingBenchmark: 0 },
      });
      // n=20, p=1/2: center=1/2; radius=1.959964*sqrt(.25/20+3.841459/(4*400))/(1+3.841459/20).
      expect(data?.confidenceInterval?.lower).toBeCloseTo(0.299298008, 8);
      expect(data?.confidenceInterval?.upper).toBeCloseTo(0.700701992, 8);
      expect(data?.confidenceInterval?.width).toBeCloseTo(0.401403983, 8);
      expect(data?.minimumSampleInterval).toMatchObject({
        denominator: 20,
        hitRate: 0.5,
        method: 'wilson',
        confidenceLevel: 0.95,
      });
      expect(data?.minimumSampleInterval.width).toBeCloseTo(0.401403983, 8);
      expect(data?.excessHitRate.confidenceInterval?.lower).toBeCloseTo(0.111861702, 8);
      expect(data?.excessHitRate.confidenceInterval?.upper).toBeCloseTo(0.468700878, 8);
    }
    expect(
      (
        await recordAdviceOutcomeTool.execute(
          {
            adviceId: 'wilson-19',
            outcome: 'followed',
            pnl: -10,
            expectedRevision: 1,
            changeNote: '基准不可确认',
          },
          ctx,
        )
      ).ok,
    ).toBe(true);
    for (const tool of [getAdviceStatsTool, getConfidenceCalibrationTool]) {
      const result = await tool.execute({}, ctx);
      if (!result.ok) throw new Error('missing benchmark fixture failed');
      expect(result.data).toMatchObject({
        denominator: 20,
        hitRate: 0.5,
        excessHitRate: {
          status: 'unavailable',
          value: null,
          denominator: 19,
          eligibleDenominator: 20,
          missingBenchmark: 1,
          confidenceInterval: null,
        },
      });
    }
  });
});

// task-31：`sampleAsOf` 取**分母口径**——未了结但更近的回填不许把样本截止推高。
describe('task-31 sampleAsOf（样本截止）', () => {
  const LATER = new Date('2099-01-01T00:00:00.000Z');

  it('未了结但更近的回填不会推高 sampleAsOf（分母口径）', async () => {
    const ctx = await buildTestContext({ advices: seedTwo(), adviceOutcomeOrigin: 'user' });
    // 一条进入分母（followed + 有限 pnl）的样本。
    expect(
      (
        await recordAdviceOutcomeTool.execute(
          { adviceId: 'stats-s1', outcome: 'followed', pnl: 500 },
          ctx,
        )
      ).ok,
    ).toBe(true);
    const afterSettled = await getAdviceStatsTool.execute({}, ctx);
    if (!afterSettled.ok) throw new Error('stats failed');
    const settledSampleAsOf = afterSettled.data.sampleAsOf;
    expect(settledSampleAsOf).toBeInstanceOf(Date);
    if (settledSampleAsOf === undefined) throw new Error('missing sampleAsOf');

    // 再造一条**更近但未了结**的回填（followed 但 pnl 缺失 → 进 excluded.unsettled）。
    expect(
      (await recordAdviceOutcomeTool.execute({ adviceId: 'stats-s2', outcome: 'followed' }, ctx))
        .ok,
    ).toBe(true);
    // 把它的 recordedAt 推到很晚，模拟「更近的回填」。
    const review = await ctx.repos.decisionReview.findBySubject({
      accountId: ctx.user.defaultAccountId,
      subject: { kind: 'advice', id: 'stats-s2' },
    });
    if (review === null) throw new Error('missing review');
    await ctx.repos.decisionReview.commit({
      accountId: ctx.user.defaultAccountId,
      requestId: crypto.randomUUID(),
      requestHash: 'later-unsettled',
      expectedRevision: review.revision.revision,
      review: review.review,
      content: review.revision.content,
      contentHash: review.revision.contentHash,
      tradeFactHashes: review.revision.tradeFactHashes,
      changeNote: 'later unsettled fixture',
      recordedAt: LATER,
    });

    const after = await getAdviceStatsTool.execute({}, ctx);
    if (!after.ok) throw new Error('stats failed');
    // 关键断言：样本截止**不被推高**（分母口径）。
    expect(after.data.sampleAsOf?.getTime()).toBe(settledSampleAsOf.getTime());
    expect(after.data.sampleAsOf?.getTime()).not.toBe(LATER.getTime());
    // 未了结那条确实进了 excluded（证明它确实「更近但没进分母」）。
    expect(after.data.excluded.unsettled).toBeGreaterThan(0);
  });

  it('没有可观测 outcome 时 sampleAsOf 缺席（不给假时间）', async () => {
    const ctx = await buildTestContext({ advices: seedTwo(), adviceOutcomeOrigin: 'user' });
    const result = await getAdviceStatsTool.execute({}, ctx);
    if (!result.ok) throw new Error('stats failed');
    expect(result.data.sampleAsOf).toBeUndefined();
    expect('sampleAsOf' in result.data).toBe(false);
  });
});
