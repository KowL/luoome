import {
  assertResearchNoteInvariants,
  type Citation,
  type ResearchNote,
  type ResearchNoteKind,
  type ResearchNoteRepository,
} from '@luoome/core';
import { and, desc, eq, gte, ne, type SQL } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { researchNotes, type Schema } from '../../schema/index.js';

type NoteRow = typeof researchNotes.$inferSelect;

const toResearchNote = (row: NoteRow): ResearchNote => ({
  id: row.id,
  stockId: row.stockId,
  kind: row.kind,
  ...(row.title !== null ? { title: row.title } : {}),
  content: row.content,
  ...(row.stance !== null ? { stance: row.stance } : {}),
  active: row.active,
  ...(row.supersedesId !== null ? { supersedesId: row.supersedesId } : {}),
  ...(row.sourceUrl !== null ? { sourceUrl: row.sourceUrl } : {}),
  ...(row.sourceTitle !== null ? { sourceTitle: row.sourceTitle } : {}),
  ...(row.sourceStatus !== null ? { sourceStatus: row.sourceStatus } : {}),
  ...(row.fetchedAt !== null ? { fetchedAt: row.fetchedAt } : {}),
  ...(row.citations !== null ? { citations: [...(row.citations as Citation[])] } : {}),
  ...(row.relatedHoldingId !== null ? { relatedHoldingId: row.relatedHoldingId } : {}),
  ...(row.relatedAdviceId !== null ? { relatedAdviceId: row.relatedAdviceId } : {}),
  ...(row.relatedWatchTriggerId !== null
    ? { relatedWatchTriggerId: row.relatedWatchTriggerId }
    : {}),
  tags: [...(row.tags as string[])],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toRow = (note: ResearchNote): typeof researchNotes.$inferInsert => ({
  id: note.id,
  stockId: note.stockId,
  kind: note.kind,
  title: note.title ?? null,
  content: note.content,
  stance: note.stance ?? null,
  active: note.active,
  supersedesId: note.supersedesId ?? null,
  sourceUrl: note.sourceUrl ?? null,
  sourceTitle: note.sourceTitle ?? null,
  sourceStatus: note.sourceStatus ?? null,
  fetchedAt: note.fetchedAt ?? null,
  citations: note.citations ? [...note.citations] : null,
  relatedHoldingId: note.relatedHoldingId ?? null,
  relatedAdviceId: note.relatedAdviceId ?? null,
  relatedWatchTriggerId: note.relatedWatchTriggerId ?? null,
  tags: [...note.tags],
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
});

/** ResearchNote Drizzle 实现（ruo 迁移 §3.1）。thesis active 唯一性用事务保证。 */
export class DrizzleResearchNoteRepository implements ResearchNoteRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(note: ResearchNote): Promise<void> {
    assertResearchNoteInvariants(note);
    const row = toRow(note);
    this.db.transaction((tx) => {
      if (note.kind === 'thesis' && note.active) {
        tx.update(researchNotes)
          .set({ active: false })
          .where(
            and(
              eq(researchNotes.stockId, note.stockId),
              eq(researchNotes.kind, 'thesis'),
              eq(researchNotes.active, true),
              ne(researchNotes.id, note.id),
            ),
          )
          .run();
      }
      tx.insert(researchNotes)
        .values(row)
        .onConflictDoUpdate({
          target: researchNotes.id,
          set: row,
        })
        .run();
    });
  }

  async findById(id: string): Promise<ResearchNote | null> {
    const row = this.db.select().from(researchNotes).where(eq(researchNotes.id, id)).get();
    return row === undefined ? null : toResearchNote(row);
  }

  async listByStock(
    stockId: string,
    opts: {
      readonly kind?: ResearchNoteKind;
      readonly activeOnly?: boolean;
      readonly since?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<readonly ResearchNote[]> {
    const conditions: SQL[] = [eq(researchNotes.stockId, stockId)];
    if (opts.kind !== undefined) conditions.push(eq(researchNotes.kind, opts.kind));
    if (opts.activeOnly === true) conditions.push(eq(researchNotes.active, true));
    if (opts.since !== undefined) conditions.push(gte(researchNotes.createdAt, opts.since));
    return this.db
      .select()
      .from(researchNotes)
      .where(and(...conditions))
      .orderBy(desc(researchNotes.createdAt))
      .limit(opts.limit ?? 200)
      .all()
      .map(toResearchNote);
  }

  async deactivateTheses(stockId: string): Promise<number> {
    const result = this.db
      .update(researchNotes)
      .set({ active: false })
      .where(
        and(
          eq(researchNotes.stockId, stockId),
          eq(researchNotes.kind, 'thesis'),
          eq(researchNotes.active, true),
        ),
      )
      .run();
    return typeof result === 'object' && result !== null && 'changes' in result
      ? Number((result as { changes: unknown }).changes)
      : 0;
  }

  async listStockIdsWithNotes(): Promise<readonly string[]> {
    return this.db
      .selectDistinct({ stockId: researchNotes.stockId })
      .from(researchNotes)
      .orderBy(researchNotes.stockId)
      .all()
      .map((row) => row.stockId);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(researchNotes).where(eq(researchNotes.id, id)).run();
  }
}
