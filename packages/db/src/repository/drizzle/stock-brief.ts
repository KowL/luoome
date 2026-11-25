import {
  type Advice,
  assertStockBriefInvariants,
  type StockBrief,
  type StockBriefPhase,
  type StockBriefRepository,
  type StockBriefUsage,
} from '@luoome/core';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, stockBriefs, watchlistMembers } from '../../schema/index.js';
import { RepositoryWriteScope } from '../../write-scope.js';
import { readAdviceRow, writeAdviceRow } from './advice.js';

type Row = typeof stockBriefs.$inferSelect;

const toBrief = (row: Row): StockBrief => ({
  id: row.id,
  tradingDate: row.tradingDate,
  phase: row.phase,
  accountId: row.accountId,
  stockId: row.stockId,
  source: row.source,
  decision: row.decision,
  confidence: row.confidence,
  horizon: row.horizon,
  ...(row.adviceId === null ? {} : { adviceId: row.adviceId }),
  quality: row.quality,
  factDigest: row.factDigest,
  factsAsOf: row.factsAsOf,
  missing: [...row.missing],
  dataSources: [...row.dataSources],
  ...(row.revisedFrom === null ? {} : { revisedFrom: row.revisedFrom }),
  llmHttpCalls: row.llmHttpCalls,
  llmPromptTokens: row.llmPromptTokens,
  llmCompletionTokens: row.llmCompletionTokens,
  llmReasoningTokens: row.llmReasoningTokens,
  llmCostUsd: row.llmCostUsd,
  validUntil: row.validUntil,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toRow = (brief: StockBrief): Row => ({
  id: brief.id,
  tradingDate: brief.tradingDate,
  phase: brief.phase,
  accountId: brief.accountId,
  stockId: brief.stockId,
  source: brief.source,
  decision: brief.decision,
  confidence: brief.confidence,
  horizon: brief.horizon,
  adviceId: brief.adviceId ?? null,
  quality: brief.quality,
  factDigest: brief.factDigest,
  factsAsOf: brief.factsAsOf,
  missing: brief.missing.map((item) => ({ ...item })),
  dataSources: [...brief.dataSources],
  revisedFrom: brief.revisedFrom ?? null,
  llmHttpCalls: brief.llmHttpCalls,
  llmPromptTokens: brief.llmPromptTokens,
  llmCompletionTokens: brief.llmCompletionTokens,
  llmReasoningTokens: brief.llmReasoningTokens,
  llmCostUsd: brief.llmCostUsd,
  validUntil: brief.validUntil,
  createdAt: brief.createdAt,
  updatedAt: brief.updatedAt,
});

type DrizzleTransaction = Parameters<Parameters<BunSQLiteDatabase<Schema>['transaction']>[0]>[0];

const findByKey = (tx: DrizzleTransaction, brief: StockBrief): Row | undefined =>
  tx
    .select()
    .from(stockBriefs)
    .where(
      and(
        eq(stockBriefs.accountId, brief.accountId),
        eq(stockBriefs.tradingDate, brief.tradingDate),
        eq(stockBriefs.stockId, brief.stockId),
        eq(stockBriefs.phase, brief.phase),
      ),
    )
    .get();

/** 在调用方事务内按唯一键幂等写入；供独立 upsert 与 advice 原子写入复用。 */
const upsertBriefRow = (tx: DrizzleTransaction, brief: StockBrief): StockBrief => {
  assertStockBriefInvariants(brief);
  const existing = findByKey(tx, brief);
  // 同键覆盖：保留首次 createdAt；结论因 factDigest 变化而更新时，把被覆盖行 id
  // 写进 revisedFrom 留链。调用方显式给出 revisedFrom 时以调用方为准。
  const revisedFrom =
    brief.revisedFrom ??
    (existing !== undefined && existing.id !== brief.id && existing.factDigest !== brief.factDigest
      ? existing.id
      : (existing?.revisedFrom ?? null));
  const row = {
    ...toRow(brief),
    revisedFrom,
    createdAt: existing?.createdAt ?? brief.createdAt,
  };
  tx.insert(stockBriefs)
    .values(row)
    .onConflictDoUpdate({
      target: [
        stockBriefs.accountId,
        stockBriefs.tradingDate,
        stockBriefs.stockId,
        stockBriefs.phase,
      ],
      set: row,
    })
    .run();
  return toBrief(row);
};

export class DrizzleStockBriefRepository implements StockBriefRepository {
  constructor(
    private readonly db: BunSQLiteDatabase<Schema>,
    private readonly writes = new RepositoryWriteScope(),
  ) {}

  async upsert(brief: StockBrief): Promise<StockBrief> {
    assertStockBriefInvariants(brief);
    return this.writes.transaction(this.db, (tx) => upsertBriefRow(tx, brief));
  }

  async upsertWithAdvice(input: {
    readonly advice: Advice;
    readonly brief: StockBrief;
  }): Promise<{ readonly advice: Advice; readonly brief: StockBrief }> {
    return this.writes.transaction(this.db, (tx) => {
      const existing = findByKey(tx, input.brief);
      if (
        existing !== undefined &&
        existing.adviceId !== null &&
        existing.factDigest === input.brief.factDigest
      ) {
        const advice = readAdviceRow(tx, existing.adviceId);
        if (advice !== undefined) {
          const brief = upsertBriefRow(tx, {
            ...toBrief(existing),
            llmHttpCalls: existing.llmHttpCalls + input.brief.llmHttpCalls,
            llmPromptTokens: existing.llmPromptTokens + input.brief.llmPromptTokens,
            llmCompletionTokens: existing.llmCompletionTokens + input.brief.llmCompletionTokens,
            llmReasoningTokens: existing.llmReasoningTokens + input.brief.llmReasoningTokens,
            llmCostUsd: existing.llmCostUsd + input.brief.llmCostUsd,
            updatedAt: input.brief.updatedAt,
          });
          return { advice, brief };
        }
      }
      writeAdviceRow(tx, input.advice);
      const brief = upsertBriefRow(tx, { ...input.brief, adviceId: input.advice.id });
      return { advice: input.advice, brief };
    });
  }

  async findById(id: string): Promise<StockBrief | null> {
    const row = this.db.select().from(stockBriefs).where(eq(stockBriefs.id, id)).get();
    return row === undefined ? null : toBrief(row);
  }

  async findByDay(input: {
    readonly tradingDate: string;
    readonly accountId?: string;
    readonly phase?: StockBriefPhase;
  }): Promise<StockBrief[]> {
    const conditions = [
      eq(stockBriefs.tradingDate, input.tradingDate),
      input.accountId === undefined ? undefined : eq(stockBriefs.accountId, input.accountId),
      input.phase === undefined ? undefined : eq(stockBriefs.phase, input.phase),
    ].filter((condition) => condition !== undefined);
    return this.db
      .select()
      .from(stockBriefs)
      .where(and(...conditions))
      .orderBy(asc(stockBriefs.accountId), asc(stockBriefs.stockId), asc(stockBriefs.phase))
      .all()
      .map(toBrief);
  }

  async findByStock(input: {
    readonly stockId: string;
    readonly accountId?: string;
    readonly tradingDate?: string;
    readonly limit?: number;
  }): Promise<StockBrief[]> {
    const conditions = [
      eq(stockBriefs.stockId, input.stockId),
      input.accountId === undefined ? undefined : eq(stockBriefs.accountId, input.accountId),
      input.tradingDate === undefined ? undefined : eq(stockBriefs.tradingDate, input.tradingDate),
    ].filter((condition) => condition !== undefined);
    const base = this.db
      .select()
      .from(stockBriefs)
      .where(and(...conditions))
      .orderBy(desc(stockBriefs.tradingDate), desc(stockBriefs.updatedAt), desc(stockBriefs.id));
    const rows = input.limit === undefined ? base.all() : base.limit(input.limit).all();
    return rows.map(toBrief);
  }

  /** 关注列表成员当日观察记录；已归档成员不参与当日候选/展示。 */
  async listByWatchlistDay(input: {
    readonly watchlistId: string;
    readonly tradingDate: string;
    readonly accountId?: string;
  }): Promise<StockBrief[]> {
    const conditions = [
      eq(watchlistMembers.watchlistId, input.watchlistId),
      isNull(watchlistMembers.archivedAt),
      eq(stockBriefs.tradingDate, input.tradingDate),
      input.accountId === undefined ? undefined : eq(stockBriefs.accountId, input.accountId),
    ].filter((condition) => condition !== undefined);
    return this.db
      .select({ brief: stockBriefs })
      .from(stockBriefs)
      .innerJoin(watchlistMembers, eq(watchlistMembers.stockId, stockBriefs.stockId))
      .where(and(...conditions))
      .orderBy(asc(stockBriefs.stockId), asc(stockBriefs.accountId), asc(stockBriefs.phase))
      .all()
      .map((row) => toBrief(row.brief));
  }

  async sumUsage(tradingDate: string): Promise<StockBriefUsage> {
    const row = this.db
      .select({
        briefs: sql<number>`count(*)`,
        httpCalls: sql<number>`coalesce(sum(${stockBriefs.llmHttpCalls}), 0)`,
        promptTokens: sql<number>`coalesce(sum(${stockBriefs.llmPromptTokens}), 0)`,
        completionTokens: sql<number>`coalesce(sum(${stockBriefs.llmCompletionTokens}), 0)`,
        reasoningTokens: sql<number>`coalesce(sum(${stockBriefs.llmReasoningTokens}), 0)`,
        costUsd: sql<number>`coalesce(sum(${stockBriefs.llmCostUsd}), 0)`,
      })
      .from(stockBriefs)
      .where(eq(stockBriefs.tradingDate, tradingDate))
      .get();
    return {
      briefs: Number(row?.briefs ?? 0),
      httpCalls: Number(row?.httpCalls ?? 0),
      promptTokens: Number(row?.promptTokens ?? 0),
      completionTokens: Number(row?.completionTokens ?? 0),
      reasoningTokens: Number(row?.reasoningTokens ?? 0),
      costUsd: Number(row?.costUsd ?? 0),
    };
  }
}
