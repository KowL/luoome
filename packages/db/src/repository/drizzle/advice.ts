import {
  type Advice,
  type AdviceDataSnapshot,
  type AdviceOutcome,
  type AdviceQuery,
  type AdviceRepository,
  assertAdviceInvariants,
  InvariantError,
  type Quote,
  type TacticSignal,
} from '@luoome/core';
import { and, desc, eq, gt, gte, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { adviceOutcomes, advices, type Schema } from '../../schema/index.js';

type AdviceRow = typeof advices.$inferSelect;
type OutcomeRow = typeof adviceOutcomes.$inferSelect;

/**
 * basedOn 走 text + json 存储，JSON.stringify 会把 Date 序列化为 ISO 字符串。
 * 读出时必须把快照里的 Date 字段（dataAsOf / quotes.*.ts / tacticSignals.*.ts）
 * revive 回 Date；其余字段（numbers / strings）JSON 往返无损。
 */
const reviveSnapshot = (raw: AdviceDataSnapshot): AdviceDataSnapshot => {
  const quotes: Record<string, Quote> | undefined =
    raw.quotes === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(raw.quotes).map(([stockId, q]) => [stockId, { ...q, ts: new Date(q.ts) }]),
        );
  const tacticSignals: TacticSignal[] | undefined =
    raw.tacticSignals === undefined
      ? undefined
      : raw.tacticSignals.map((s) => ({ ...s, ts: new Date(s.ts) }));
  return {
    ...(quotes !== undefined ? { quotes } : {}),
    ...(raw.indicators !== undefined ? { indicators: raw.indicators } : {}),
    ...(tacticSignals !== undefined ? { tacticSignals } : {}),
    ...(raw.llmReasoning !== undefined ? { llmReasoning: raw.llmReasoning } : {}),
    dataAsOf: new Date(raw.dataAsOf),
  };
};

const toAdvice = (row: AdviceRow, outcome: AdviceOutcome | null): Advice => {
  const advice: Advice = {
    id: row.id,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    decision: row.decision,
    confidence: row.confidence,
    horizon: row.horizon,
    reasoning: row.reasoning,
    risks: row.risks,
    disclaimers: row.disclaimers,
    ...(row.sourceTool !== null ? { sourceTool: row.sourceTool } : {}),
    ...(row.sourceWorkflow !== null ? { sourceWorkflow: row.sourceWorkflow } : {}),
    basedOn: reviveSnapshot(row.basedOn),
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    createdAt: row.createdAt,
    ...(outcome !== null ? { outcome } : {}),
  };
  return advice;
};

const toOutcome = (row: OutcomeRow): AdviceOutcome => ({
  adviceId: row.adviceId,
  outcome: row.outcome,
  ...(row.pnl !== null ? { pnl: row.pnl } : {}),
  ...(row.benchmarkPnl !== null ? { benchmarkPnl: row.benchmarkPnl } : {}),
  recordedAt: row.recordedAt,
});

export class DrizzleAdviceRepository implements AdviceRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(advice: Advice): Promise<void> {
    assertAdviceInvariants(advice);
    const row = {
      id: advice.id,
      subjectKind: advice.subjectKind,
      subjectId: advice.subjectId,
      decision: advice.decision,
      confidence: advice.confidence,
      horizon: advice.horizon,
      reasoning: advice.reasoning,
      risks: advice.risks,
      disclaimers: advice.disclaimers,
      sourceTool: advice.sourceTool ?? null,
      sourceWorkflow: advice.sourceWorkflow ?? null,
      basedOn: advice.basedOn,
      validFrom: advice.validFrom,
      validUntil: advice.validUntil,
      createdAt: advice.createdAt,
    };
    this.db.insert(advices).values(row).onConflictDoUpdate({ target: advices.id, set: row }).run();
  }

  async findById(id: string): Promise<Advice | null> {
    const row = this.db.select().from(advices).where(eq(advices.id, id)).get();
    if (row === undefined) return null;
    return toAdvice(row, await this.getOutcome(id));
  }

  /**
   * 过滤语义（ARCHITECTURE §6.5）：
   * - since/until 作用于 createdAt（闭区间）
   * - 默认不返回过期 advice（validUntil <= now），includeExpired: true 才返回
   * - 结果按 createdAt 倒序（id 决胜）
   */
  async query(filter: AdviceQuery): Promise<Advice[]> {
    const conditions = [
      filter.subjectKind !== undefined ? eq(advices.subjectKind, filter.subjectKind) : undefined,
      filter.subjectId !== undefined ? eq(advices.subjectId, filter.subjectId) : undefined,
      filter.decision !== undefined ? eq(advices.decision, filter.decision) : undefined,
      filter.sourceTool !== undefined ? eq(advices.sourceTool, filter.sourceTool) : undefined,
      filter.since !== undefined ? gte(advices.createdAt, filter.since) : undefined,
      filter.until !== undefined ? lte(advices.createdAt, filter.until) : undefined,
      filter.includeExpired === true ? undefined : gt(advices.validUntil, new Date()),
    ].filter((c) => c !== undefined);
    const base = this.db
      .select()
      .from(advices)
      .where(and(...conditions))
      .orderBy(desc(advices.createdAt), desc(advices.id));
    const rows = filter.limit !== undefined ? base.limit(filter.limit).all() : base.all();
    const outcomes = await Promise.all(rows.map((r) => this.getOutcome(r.id)));
    return rows.map((r, i) => toAdvice(r, outcomes[i] ?? null));
  }

  async recordOutcome(adviceId: string, outcome: AdviceOutcome): Promise<void> {
    if (outcome.adviceId !== adviceId) {
      throw new InvariantError(
        `outcome.adviceId (${outcome.adviceId}) must equal adviceId (${adviceId})`,
      );
    }
    const row = {
      adviceId,
      outcome: outcome.outcome,
      pnl: outcome.pnl ?? null,
      benchmarkPnl: outcome.benchmarkPnl ?? null,
      recordedAt: outcome.recordedAt,
    };
    this.db
      .insert(adviceOutcomes)
      .values(row)
      .onConflictDoUpdate({ target: adviceOutcomes.adviceId, set: row })
      .run();
  }

  /**
   * 读取已回填的 outcome（超出 core 接口的便捷方法，供 stats / 测试使用）。
   * core 的 AdviceRepository 接口 v0.1 未暴露 outcome 读取，工具层可直接用具体类。
   */
  async getOutcome(adviceId: string): Promise<AdviceOutcome | null> {
    const row = this.db
      .select()
      .from(adviceOutcomes)
      .where(eq(adviceOutcomes.adviceId, adviceId))
      .get();
    return row === undefined ? null : toOutcome(row);
  }
}
