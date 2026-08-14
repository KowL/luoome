import {
  type PortfolioCashFlow,
  type PortfolioCashFlowRepository,
  PortfolioCashFlowSchema,
  type PortfolioCorporateAction,
  type PortfolioCorporateActionRepository,
  PortfolioCorporateActionSchema,
} from '@luoome/core';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { portfolioCashFlows, portfolioCorporateActions, type Schema } from '../../schema/index.js';

const parseCashFlow = (row: typeof portfolioCashFlows.$inferSelect): PortfolioCashFlow =>
  (() => {
    const { stockId, note, ...base } = row;
    return PortfolioCashFlowSchema.parse({
      ...base,
      ...(stockId === null ? {} : { stockId }),
      ...(note === null ? {} : { note }),
    });
  })();

const parseCorporateAction = (
  row: typeof portfolioCorporateActions.$inferSelect,
): PortfolioCorporateAction =>
  (() => {
    const { ratio, cashPerShare, note, ...base } = row;
    return PortfolioCorporateActionSchema.parse({
      ...base,
      ...(ratio === null ? {} : { ratio }),
      ...(cashPerShare === null ? {} : { cashPerShare }),
      ...(note === null ? {} : { note }),
    });
  })();

export class DrizzlePortfolioCashFlowRepository implements PortfolioCashFlowRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(flow: PortfolioCashFlow): Promise<void> {
    const parsed = PortfolioCashFlowSchema.parse(flow);
    this.db
      .insert(portfolioCashFlows)
      .values({ ...parsed, stockId: parsed.stockId ?? null, note: parsed.note ?? null })
      .onConflictDoUpdate({
        target: portfolioCashFlows.id,
        set: { ...parsed, stockId: parsed.stockId ?? null, note: parsed.note ?? null },
      })
      .run();
  }

  async findById(id: string): Promise<PortfolioCashFlow | null> {
    const row = this.db
      .select()
      .from(portfolioCashFlows)
      .where(eq(portfolioCashFlows.id, id))
      .get();
    return row === undefined ? null : parseCashFlow(row);
  }

  async listByAccount(accountId: string, from?: Date, to?: Date): Promise<PortfolioCashFlow[]> {
    return this.db
      .select()
      .from(portfolioCashFlows)
      .where(
        and(
          eq(portfolioCashFlows.accountId, accountId),
          from === undefined ? undefined : gte(portfolioCashFlows.occurredAt, from),
          to === undefined ? undefined : lte(portfolioCashFlows.occurredAt, to),
        ),
      )
      .orderBy(asc(portfolioCashFlows.occurredAt), asc(portfolioCashFlows.id))
      .all()
      .map(parseCashFlow);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(portfolioCashFlows).where(eq(portfolioCashFlows.id, id)).run();
  }
}

export class DrizzlePortfolioCorporateActionRepository
  implements PortfolioCorporateActionRepository
{
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(action: PortfolioCorporateAction): Promise<void> {
    const parsed = PortfolioCorporateActionSchema.parse(action);
    this.db
      .insert(portfolioCorporateActions)
      .values({
        ...parsed,
        ratio: parsed.ratio ?? null,
        cashPerShare: parsed.cashPerShare ?? null,
        note: parsed.note ?? null,
      })
      .onConflictDoUpdate({
        target: portfolioCorporateActions.id,
        set: {
          ...parsed,
          ratio: parsed.ratio ?? null,
          cashPerShare: parsed.cashPerShare ?? null,
          note: parsed.note ?? null,
        },
      })
      .run();
  }

  async findById(id: string): Promise<PortfolioCorporateAction | null> {
    const row = this.db
      .select()
      .from(portfolioCorporateActions)
      .where(eq(portfolioCorporateActions.id, id))
      .get();
    return row === undefined ? null : parseCorporateAction(row);
  }

  async listByAccount(
    accountId: string,
    from?: Date,
    to?: Date,
  ): Promise<PortfolioCorporateAction[]> {
    return this.db
      .select()
      .from(portfolioCorporateActions)
      .where(
        and(
          eq(portfolioCorporateActions.accountId, accountId),
          from === undefined ? undefined : gte(portfolioCorporateActions.occurredAt, from),
          to === undefined ? undefined : lte(portfolioCorporateActions.occurredAt, to),
        ),
      )
      .orderBy(asc(portfolioCorporateActions.occurredAt), asc(portfolioCorporateActions.id))
      .all()
      .map(parseCorporateAction);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(portfolioCorporateActions).where(eq(portfolioCorporateActions.id, id)).run();
  }
}
