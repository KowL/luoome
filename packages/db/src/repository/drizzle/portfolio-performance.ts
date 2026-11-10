import {
  type PortfolioCashFlow,
  type PortfolioCashFlowKind,
  type PortfolioCashFlowRepository,
  PortfolioCashFlowSchema,
  type PortfolioCashFlowSource,
  type PortfolioCorporateAction,
  type PortfolioCorporateActionRepository,
  PortfolioCorporateActionSchema,
} from '@luoome/core';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { accountLedgerEntries, type Schema } from '../../schema/index.js';

type LedgerRow = typeof accountLedgerEntries.$inferSelect;

const parseCashFlow = (row: LedgerRow): PortfolioCashFlow =>
  PortfolioCashFlowSchema.parse({
    id: row.id,
    accountId: row.accountId,
    occurredAt: row.occurredAt,
    kind: row.flowKind as PortfolioCashFlowKind,
    amount: row.amount,
    currency: row.currency,
    ...(row.stockId === null ? {} : { stockId: row.stockId }),
    source: row.source as PortfolioCashFlowSource,
    ...(row.note === null ? {} : { note: row.note }),
    createdAt: row.createdAt ?? row.occurredAt,
  });

const parseCorporateAction = (row: LedgerRow): PortfolioCorporateAction =>
  PortfolioCorporateActionSchema.parse({
    id: row.id,
    accountId: row.accountId,
    stockId: row.stockId,
    occurredAt: row.occurredAt,
    kind: row.actionKind,
    ...(row.ratio === null ? {} : { ratio: row.ratio }),
    ...(row.cashPerShare === null ? {} : { cashPerShare: row.cashPerShare }),
    source: row.source as PortfolioCashFlowSource,
    ...(row.note === null ? {} : { note: row.note }),
    createdAt: row.createdAt ?? row.occurredAt,
  });

/** 资金流水与公司行动都是 account_ledger_entries 的投影（§6 单表合并）。 */
export class DrizzlePortfolioCashFlowRepository implements PortfolioCashFlowRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(flow: PortfolioCashFlow): Promise<void> {
    const parsed = PortfolioCashFlowSchema.parse(flow);
    const row = {
      id: parsed.id,
      accountId: parsed.accountId,
      entryKind: 'cash-flow',
      occurredAt: parsed.occurredAt,
      amount: parsed.amount,
      currency: parsed.currency,
      stockId: parsed.stockId ?? null,
      flowKind: parsed.kind,
      source: parsed.source,
      note: parsed.note ?? null,
      createdAt: parsed.createdAt,
    };
    this.db
      .insert(accountLedgerEntries)
      .values(row)
      .onConflictDoUpdate({ target: accountLedgerEntries.id, set: row })
      .run();
  }

  async findById(id: string): Promise<PortfolioCashFlow | null> {
    const row = this.db
      .select()
      .from(accountLedgerEntries)
      .where(and(eq(accountLedgerEntries.id, id), eq(accountLedgerEntries.entryKind, 'cash-flow')))
      .get();
    return row === undefined ? null : parseCashFlow(row);
  }

  async listByAccount(accountId: string, from?: Date, to?: Date): Promise<PortfolioCashFlow[]> {
    return this.db
      .select()
      .from(accountLedgerEntries)
      .where(
        and(
          eq(accountLedgerEntries.accountId, accountId),
          eq(accountLedgerEntries.entryKind, 'cash-flow'),
          from === undefined ? undefined : gte(accountLedgerEntries.occurredAt, from),
          to === undefined ? undefined : lte(accountLedgerEntries.occurredAt, to),
        ),
      )
      .orderBy(asc(accountLedgerEntries.occurredAt), asc(accountLedgerEntries.id))
      .all()
      .map(parseCashFlow);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(accountLedgerEntries).where(eq(accountLedgerEntries.id, id)).run();
  }
}

export class DrizzlePortfolioCorporateActionRepository
  implements PortfolioCorporateActionRepository
{
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(action: PortfolioCorporateAction): Promise<void> {
    const parsed = PortfolioCorporateActionSchema.parse(action);
    const row = {
      id: parsed.id,
      accountId: parsed.accountId,
      entryKind: 'corporate-action',
      occurredAt: parsed.occurredAt,
      stockId: parsed.stockId,
      actionKind: parsed.kind,
      ratio: parsed.ratio ?? null,
      cashPerShare: parsed.cashPerShare ?? null,
      source: parsed.source,
      note: parsed.note ?? null,
      createdAt: parsed.createdAt,
    };
    this.db
      .insert(accountLedgerEntries)
      .values(row)
      .onConflictDoUpdate({ target: accountLedgerEntries.id, set: row })
      .run();
  }

  async findById(id: string): Promise<PortfolioCorporateAction | null> {
    const row = this.db
      .select()
      .from(accountLedgerEntries)
      .where(
        and(
          eq(accountLedgerEntries.id, id),
          eq(accountLedgerEntries.entryKind, 'corporate-action'),
        ),
      )
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
      .from(accountLedgerEntries)
      .where(
        and(
          eq(accountLedgerEntries.accountId, accountId),
          eq(accountLedgerEntries.entryKind, 'corporate-action'),
          from === undefined ? undefined : gte(accountLedgerEntries.occurredAt, from),
          to === undefined ? undefined : lte(accountLedgerEntries.occurredAt, to),
        ),
      )
      .orderBy(asc(accountLedgerEntries.occurredAt), asc(accountLedgerEntries.id))
      .all()
      .map(parseCorporateAction);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(accountLedgerEntries).where(eq(accountLedgerEntries.id, id)).run();
  }
}
