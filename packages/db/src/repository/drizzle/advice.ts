import {
  type Advice,
  type AdviceDataSnapshot,
  type AdviceOutcome,
  type AdviceOutcomeQuery,
  type AdviceQuery,
  type AdviceRepository,
  assertAdviceInvariants,
  InvariantError,
  type Quote,
  QuoteSchema,
} from '@luoome/core';
import { and, desc, eq, gt, gte, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { adviceOutcomes, advices, type Schema } from '../../schema/index.js';

type AdviceRow = typeof advices.$inferSelect;
type OutcomeRow = typeof adviceOutcomes.$inferSelect;

/**
 * basedOn 走 text + json 存储，JSON.stringify 会把 Date 序列化为 ISO 字符串。
 * 读出时必须把快照里的 Date 字段（dataAsOf / quotes.*.ts）revive 回 Date；
 * 其余字段（numbers / strings）JSON 往返无损。
 * 存量行的 basedOn 可能仍含已下线的 tacticSignals key：这里不读取它，
 * 落库对象不再携带该字段即可（读兼容 = 不 crash、不 resurrect）。
 */
const reviveSnapshot = (raw: AdviceDataSnapshot): AdviceDataSnapshot => {
  const quotes: Record<string, Quote> | undefined =
    raw.quotes === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(raw.quotes).map(([stockId, quote]) => [stockId, QuoteSchema.parse(quote)]),
        );
  return {
    ...(quotes !== undefined ? { quotes } : {}),
    ...(raw.indicators !== undefined ? { indicators: raw.indicators } : {}),
    ...(raw.llmReasoning !== undefined ? { llmReasoning: raw.llmReasoning } : {}),
    dataAsOf: new Date(raw.dataAsOf),
  };
};

const toAdvice = (row: AdviceRow, outcome: AdviceOutcome | null): Advice => {
  const advice: Advice = {
    id: row.id,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    ...(row.stockName !== null ? { stockName: row.stockName } : {}),
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
  tradeIds: row.tradeIds,
  outcome: row.outcome,
  ...(row.pnl !== null ? { pnl: row.pnl } : {}),
  ...(row.benchmarkPnl !== null ? { benchmarkPnl: row.benchmarkPnl } : {}),
  ...(row.holdingHours !== null ? { holdingHours: row.holdingHours } : {}),
  ...(row.notes !== null ? { notes: row.notes } : {}),
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
      stockName: advice.stockName ?? null,
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
    return toAdvice(row, await this.findOutcome(id));
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
    const outcomes = await Promise.all(rows.map((r) => this.findOutcome(r.id)));
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
      tradeIds: outcome.tradeIds,
      outcome: outcome.outcome,
      pnl: outcome.pnl ?? null,
      benchmarkPnl: outcome.benchmarkPnl ?? null,
      holdingHours: outcome.holdingHours ?? null,
      notes: outcome.notes ?? null,
      recordedAt: outcome.recordedAt,
    };
    this.db
      .insert(adviceOutcomes)
      .values(row)
      .onConflictDoUpdate({ target: adviceOutcomes.adviceId, set: row })
      .run();
  }

  async findOutcome(adviceId: string): Promise<AdviceOutcome | null> {
    const row = this.db
      .select()
      .from(adviceOutcomes)
      .where(eq(adviceOutcomes.adviceId, adviceId))
      .get();
    return row === undefined ? null : toOutcome(row);
  }

  async listOutcomes(filter: AdviceOutcomeQuery = {}): Promise<AdviceOutcome[]> {
    const conditions = [
      filter.adviceId !== undefined ? eq(adviceOutcomes.adviceId, filter.adviceId) : undefined,
      filter.subjectKind !== undefined ? eq(advices.subjectKind, filter.subjectKind) : undefined,
      filter.subjectId !== undefined ? eq(advices.subjectId, filter.subjectId) : undefined,
      filter.since !== undefined ? gte(adviceOutcomes.recordedAt, filter.since) : undefined,
      filter.until !== undefined ? lte(adviceOutcomes.recordedAt, filter.until) : undefined,
    ].filter((condition) => condition !== undefined);
    const base = this.db
      .select({ outcome: adviceOutcomes })
      .from(adviceOutcomes)
      .innerJoin(advices, eq(adviceOutcomes.adviceId, advices.id))
      .where(and(...conditions))
      .orderBy(desc(adviceOutcomes.recordedAt), desc(adviceOutcomes.adviceId));
    const rows = filter.limit !== undefined ? base.limit(filter.limit).all() : base.all();
    return rows.map((row) => toOutcome(row.outcome));
  }

  /** 兼容旧调用方；新代码应使用 AdviceRepository.findOutcome。 */
  async getOutcome(adviceId: string): Promise<AdviceOutcome | null> {
    return this.findOutcome(adviceId);
  }

  async remove(id: string): Promise<void> {
    this.db.transaction((tx) => {
      tx.delete(adviceOutcomes).where(eq(adviceOutcomes.adviceId, id)).run();
      tx.delete(advices).where(eq(advices.id, id)).run();
    });
  }
}
