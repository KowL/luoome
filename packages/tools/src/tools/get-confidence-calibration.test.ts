import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getConfidenceCalibrationTool } from './get-confidence-calibration.js';
import { recordAdviceOutcomeTool } from './record-advice-outcome.js';

describe('get_confidence_calibration', () => {
  it('正常路径：空 advice 库 → 全 0 bucket，total=0', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const result = await getConfidenceCalibrationTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalAdvices).toBe(0);
    expect(result.data.totalWithOutcome).toBe(0);
    expect(result.data.overallHitRate).toBe(0);
    expect(result.data.buckets).toHaveLength(10);
    for (const b of result.data.buckets) {
      expect(b.total).toBe(0);
      expect(b.withOutcome).toBe(0);
      expect(b.hitRate).toBe(0);
    }
  });

  it('正常路径：含 outcome 后按桶聚合（hitRate + avgPnl 不跨桶算错）', async () => {
    const ctx = await buildTestContext({ advices: [] });
    // 直接灌入不同 confidence 的 advice + outcome，验证桶归位与命中逻辑。
    const now = new Date('2026-07-15T08:00:00Z');
    const seedAdvices = [
      {
        id: 'adv-low',
        subjectKind: 'stock' as const,
        subjectId: '002594.SZ',
        decision: 'buy' as const,
        confidence: 25,
        hit: true,
      },
      {
        id: 'adv-low-2',
        subjectKind: 'stock' as const,
        subjectId: '600519.SH',
        decision: 'hold' as const,
        confidence: 35,
        hit: false,
      },
      {
        id: 'adv-mid',
        subjectKind: 'stock' as const,
        subjectId: '300750.SZ',
        decision: 'buy' as const,
        confidence: 65,
        hit: true,
      },
      {
        id: 'adv-mid-2',
        subjectKind: 'stock' as const,
        subjectId: '300750.SZ',
        decision: 'sell' as const,
        confidence: 75,
        hit: false,
      },
      {
        id: 'adv-high',
        subjectKind: 'stock' as const,
        subjectId: '600036.SH',
        decision: 'buy' as const,
        confidence: 92,
        hit: true,
      },
    ];
    for (const a of seedAdvices) {
      await ctx.repos.advice.save({
        id: a.id,
        subjectKind: a.subjectKind,
        subjectId: a.subjectId,
        decision: a.decision,
        confidence: a.confidence,
        horizon: 'short',
        reasoning: { premise: 'fixture', evidence: [], counterEvidence: [] },
        risks: [],
        disclaimers: [
          '本建议由 AI 生成，基于历史数据与技术指标，不构成投资建议。',
          '投资有风险，决策需自行承担。',
          '市场有不可预测性，过往表现不代表未来收益。',
        ],
        basedOn: { dataAsOf: now },
        validFrom: now,
        validUntil: new Date(now.getTime() + 3 * 86_400_000),
        createdAt: now,
      });
      // outcome：hit → followed + pnl=10；否则 → followed + pnl=-5
      const outcomeResult = await recordAdviceOutcomeTool.execute(
        {
          adviceId: a.id,
          followed: true,
          pnl: a.hit ? 10 : -5,
        },
        ctx,
      );
      expect(outcomeResult.ok).toBe(true);
    }
    const result = await getConfidenceCalibrationTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalAdvices).toBe(5);
    expect(result.data.totalWithOutcome).toBe(5);
    expect(result.data.buckets).toHaveLength(10);
    // bucket2 = 20-29：adv-low 落入；hits=1；withOutcome=1；hitRate=1
    const b2 = result.data.buckets[2];
    expect(b2).toBeDefined();
    if (b2 !== undefined) {
      expect(b2.range).toEqual({ min: 20, max: 29 });
      expect(b2.total).toBe(1);
      expect(b2.withOutcome).toBe(1);
      expect(b2.hits).toBe(1);
      expect(b2.hitRate).toBe(1);
    }
    // bucket3 = 30-39：adv-low-2；hit=false → hits=0；hitRate=0；avgPnl=-5
    const b3 = result.data.buckets[3];
    expect(b3).toBeDefined();
    if (b3 !== undefined) {
      expect(b3.total).toBe(1);
      expect(b3.withOutcome).toBe(1);
      expect(b3.hits).toBe(0);
      expect(b3.hitRate).toBe(0);
      expect(b3.avgPnl).toBe(-5);
    }
    // bucket6 = 60-69：adv-mid；hits=1
    const b6 = result.data.buckets[6];
    expect(b6).toBeDefined();
    if (b6 !== undefined) {
      expect(b6.total).toBe(1);
      expect(b6.hits).toBe(1);
    }
    // bucket7 = 70-79：adv-mid-2；hit=false → hits=0
    const b7 = result.data.buckets[7];
    expect(b7).toBeDefined();
    if (b7 !== undefined) {
      expect(b7.total).toBe(1);
      expect(b7.hits).toBe(0);
      expect(b7.hitRate).toBe(0);
    }
    // bucket9 = 90-100：adv-high；hits=1；confidence=92 → avgConfidence=92
    const b9 = result.data.buckets[9];
    expect(b9).toBeDefined();
    if (b9 !== undefined) {
      expect(b9.range).toEqual({ min: 90, max: 100 });
      expect(b9.total).toBe(1);
      expect(b9.hits).toBe(1);
      expect(b9.hitRate).toBe(1);
      expect(b9.avgConfidence).toBe(92);
    }
    // overallHitRate = (1+0+1+0+1) / 5 = 0.6
    expect(result.data.overallHitRate).toBeCloseTo(0.6, 5);
  });

  it('正常路径：未回填的 advice 计入 total，不污染 hitRate', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const now = new Date('2026-07-15T08:00:00Z');
    // 灌 3 条 advice，1 条 outcome
    for (const id of ['a1', 'a2', 'a3']) {
      await ctx.repos.advice.save({
        id,
        subjectKind: 'stock',
        subjectId: '002594.SZ',
        decision: 'buy',
        confidence: 50,
        horizon: 'short',
        reasoning: { premise: 'x', evidence: [], counterEvidence: [] },
        risks: [],
        disclaimers: [
          '本建议由 AI 生成，基于历史数据与技术指标，不构成投资建议。',
          '投资有风险，决策需自行承担。',
          '市场有不可预测性，过往表现不代表未来收益。',
        ],
        basedOn: { dataAsOf: now },
        validFrom: now,
        validUntil: new Date(now.getTime() + 3 * 86_400_000),
        createdAt: now,
      });
    }
    const r = await recordAdviceOutcomeTool.execute(
      { adviceId: 'a1', followed: true, pnl: 100 },
      ctx,
    );
    expect(r.ok).toBe(true);
    const result = await getConfidenceCalibrationTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalAdvices).toBe(3);
    expect(result.data.totalWithOutcome).toBe(1);
    const b5 = result.data.buckets[5];
    expect(b5).toBeDefined();
    if (b5 !== undefined) {
      expect(b5.total).toBe(3);
      expect(b5.withOutcome).toBe(1);
      expect(b5.hits).toBe(1);
      expect(b5.hitRate).toBe(1);
    }
    expect(result.data.overallHitRate).toBe(1);
  });

  it('按 since 过滤：窗口外的 advice 不计入', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const t0 = new Date('2026-06-01T08:00:00Z');
    const t1 = new Date('2026-07-01T08:00:00Z');
    // 在 t0 灌一条建议，t1 灌一条
    for (const [id, createdAt] of [
      ['a-old', t0],
      ['a-new', t1],
    ] as const) {
      await ctx.repos.advice.save({
        id,
        subjectKind: 'stock',
        subjectId: '002594.SZ',
        decision: 'buy',
        confidence: 50,
        horizon: 'short',
        reasoning: { premise: 'x', evidence: [], counterEvidence: [] },
        risks: [],
        disclaimers: [
          '本建议由 AI 生成，基于历史数据与技术指标，不构成投资建议。',
          '投资有风险，决策需自行承担。',
          '市场有不可预测性，过往表现不代表未来收益。',
        ],
        basedOn: { dataAsOf: createdAt },
        validFrom: createdAt,
        validUntil: new Date(createdAt.getTime() + 3 * 86_400_000),
        createdAt,
      });
    }
    const result = await getConfidenceCalibrationTool.execute(
      { since: new Date('2026-06-15T00:00:00Z') },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalAdvices).toBe(1);
    const b5 = result.data.buckets[5];
    expect(b5?.total).toBe(1);
  });
});
