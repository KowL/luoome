import {
  assertTacticInvariants,
  type Tactic,
  type TacticRepository,
  type TacticSignal,
} from '@luoome/core';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, tacticSignals, tactics } from '../../schema/index.js';

type TacticRow = typeof tactics.$inferSelect;
type SignalRow = typeof tacticSignals.$inferSelect;

const toTactic = (row: TacticRow): Tactic => ({
  id: row.id,
  name: row.name,
  tag: row.tag,
  description: row.description,
  triggerWhen: row.triggerWhen,
  scoreExpression: row.scoreExpression,
  direction: row.direction,
  evidenceTemplate: [...row.evidenceTemplate], // drizzle 类型是 mutable，转回 readonly
  source: row.source,
  definedAt: row.definedAt,
});

const toSignal = (row: SignalRow): TacticSignal => {
  const base: TacticSignal = {
    tacticId: row.tacticId,
    tacticName: row.tacticName,
    tacticTag: row.tacticTag,
    stockId: row.stockId,
    ts: row.ts,
    score: row.score,
    direction: row.direction,
    evidence: row.evidence,
  };
  return row.triggerSnapshot !== null
    ? Object.assign(base, { triggerSnapshot: row.triggerSnapshot })
    : base;
};

export class DrizzleTacticRepository implements TacticRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(tactic: Tactic): Promise<void> {
    assertTacticInvariants(tactic);
    this.db
      .insert(tactics)
      .values({
        id: tactic.id,
        name: tactic.name,
        tag: tactic.tag,
        description: tactic.description,
        triggerWhen: tactic.triggerWhen,
        scoreExpression: tactic.scoreExpression,
        direction: tactic.direction,
        evidenceTemplate: [...tactic.evidenceTemplate], // drizzle 要求 mutable
        source: tactic.source,
        definedAt: tactic.definedAt,
      })
      .onConflictDoUpdate({
        target: tactics.id,
        set: {
          name: tactic.name,
          tag: tactic.tag,
          description: tactic.description,
          triggerWhen: tactic.triggerWhen,
          scoreExpression: tactic.scoreExpression,
          direction: tactic.direction,
          evidenceTemplate: [...tactic.evidenceTemplate], // drizzle 要求 mutable
          source: tactic.source,
        },
      })
      .run();
  }

  async findById(id: string): Promise<Tactic | null> {
    const row = this.db.select().from(tactics).where(eq(tactics.id, id)).get();
    return row === undefined ? null : toTactic(row);
  }

  async list(
    filter: { readonly tag?: Tactic['tag']; readonly source?: Tactic['source'] } = {},
  ): Promise<readonly Tactic[]> {
    const conditions = [];
    if (filter.tag !== undefined) conditions.push(eq(tactics.tag, filter.tag));
    if (filter.source !== undefined) conditions.push(eq(tactics.source, filter.source));
    const where = conditions.length === 0 ? undefined : and(...conditions);
    const rows = this.db.select().from(tactics).where(where).orderBy(tactics.id).all();
    return rows.map(toTactic);
  }

  async saveSignal(signal: TacticSignal): Promise<void> {
    // 信号用 signal 自己的 tacticId+stockId+ts 复合做 id（确保唯一）。
    const id = `${signal.tacticId}-${signal.stockId}-${signal.ts.getTime()}`;
    this.db
      .insert(tacticSignals)
      .values({
        id,
        tacticId: signal.tacticId,
        tacticName: signal.tacticName,
        tacticTag: signal.tacticTag,
        stockId: signal.stockId,
        ts: signal.ts,
        score: signal.score,
        direction: signal.direction,
        evidence: signal.evidence,
        ...(signal.triggerSnapshot !== undefined
          ? { triggerSnapshot: signal.triggerSnapshot }
          : { triggerSnapshot: null }),
      })
      .onConflictDoUpdate({
        target: tacticSignals.id,
        set: {
          score: signal.score,
          evidence: signal.evidence,
          ...(signal.triggerSnapshot !== undefined
            ? { triggerSnapshot: signal.triggerSnapshot }
            : {}),
        },
      })
      .run();
  }

  async signalsByTactic(tacticId: string, since?: Date): Promise<readonly TacticSignal[]> {
    const condition =
      since === undefined
        ? eq(tacticSignals.tacticId, tacticId)
        : and(eq(tacticSignals.tacticId, tacticId), gte(tacticSignals.ts, since));
    return this.db
      .select()
      .from(tacticSignals)
      .where(condition)
      .orderBy(desc(tacticSignals.ts))
      .all()
      .map(toSignal);
  }

  async signalsByStock(stockId: string, since?: Date): Promise<readonly TacticSignal[]> {
    const condition =
      since === undefined
        ? eq(tacticSignals.stockId, stockId)
        : and(eq(tacticSignals.stockId, stockId), gte(tacticSignals.ts, since));
    return this.db
      .select()
      .from(tacticSignals)
      .where(condition)
      .orderBy(desc(tacticSignals.ts))
      .all()
      .map(toSignal);
  }
}
