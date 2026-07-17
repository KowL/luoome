import { type Advice, type AdviceRepository, money, STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildContext, buildMockContext } from '../context.js';
import { getAdviceStatsTool } from './get-advice-stats.js';

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
  basedOn: { dataAsOf: new Date('2026-01-01T00:00:00.000Z') },
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
    const ctx = await buildMockContext({ advices: seedTwo() });
    await ctx.repos.advice.recordOutcome('stats-s1', {
      adviceId: 'stats-s1',
      outcome: 'followed',
      pnl: money(500),
      recordedAt: new Date('2026-01-05T00:00:00.000Z'),
    });

    const result = await getAdviceStatsTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stats = result.data;
    expect(stats.totalAdvices).toBe(2);
    expect(stats.avgConfidence).toBe(70);
    expect(stats.outcomeRate.followed).toBe(0.5);
    expect(stats.outcomeRate.partiallyFollowed).toBe(0);
    expect(stats.outcomeRate.ignored).toBe(0);
    expect(stats.pnlWhenFollowed).toBe(500);
    expect(stats.pnlWhenIgnored).toBe(0);
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
    const ctx = await buildMockContext({ advices: seedTwo() });
    const result = await getAdviceStatsTool.execute({ subjectId: '600519.SH' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalAdvices).toBe(0);
    expect(result.data.avgConfidence).toBe(0);
    expect(result.data.hitRate).toBe(0);
    expect(result.data.byDecision.buy?.totalAdvices).toBe(0);
  });

  it('降级路径：repo 无 getOutcome → outcome 维度按空统计（不报错）', async () => {
    const mockCtx = await buildMockContext({ advices: seedTwo() });
    const base = mockCtx.repos.advice;
    // 只实现 core AdviceRepository 接口的 4 个方法（无 getOutcome 便捷方法）。
    const interfaceOnlyAdviceRepo: AdviceRepository = {
      save: (advice) => base.save(advice),
      findById: (id) => base.findById(id),
      query: (filter) => base.query(filter),
      recordOutcome: (adviceId, outcome) => base.recordOutcome(adviceId, outcome),
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
    expect(result.data.hitRate).toBe(0);
  });

  it('错误路径：非法 since → invalid_input', async () => {
    const ctx = await buildMockContext({ advices: seedTwo() });
    const result = await getAdviceStatsTool.execute({ since: 'not-a-date' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });
});
