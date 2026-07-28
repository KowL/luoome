import {
  assertResearchNoteInvariants,
  type ResearchNote,
  type ResearchNoteKind,
  type ResearchNoteRepository,
} from '@luoome/core';

/**
 * ResearchNote in-memory 实现（ruo 迁移 §3.1）。
 * save 一条 active=true 的 thesis 时，同 stockId 其它 thesis 置 active=false（事务语义）。
 */
export class InMemoryResearchNoteRepository implements ResearchNoteRepository {
  private readonly items = new Map<string, ResearchNote>();

  put(note: ResearchNote): void {
    assertResearchNoteInvariants(note);
    this.items.set(note.id, note);
  }

  async save(note: ResearchNote): Promise<void> {
    assertResearchNoteInvariants(note);
    if (note.kind === 'thesis' && note.active) {
      for (const [id, n] of this.items) {
        if (id === note.id) continue;
        if (n.stockId === note.stockId && n.kind === 'thesis' && n.active) {
          this.items.set(id, { ...n, active: false });
        }
      }
    }
    this.items.set(note.id, note);
  }

  async findById(id: string): Promise<ResearchNote | null> {
    return this.items.get(id) ?? null;
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
    const sinceMs = opts.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    const limit = opts.limit ?? 200;
    return [...this.items.values()]
      .filter((n) => n.stockId === stockId)
      .filter((n) => opts.kind === undefined || n.kind === opts.kind)
      .filter((n) => opts.activeOnly !== true || n.active)
      .filter((n) => n.createdAt.getTime() >= sinceMs)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async deactivateTheses(stockId: string): Promise<number> {
    let count = 0;
    for (const [id, n] of this.items) {
      if (n.stockId === stockId && n.kind === 'thesis' && n.active) {
        this.items.set(id, { ...n, active: false });
        count += 1;
      }
    }
    return count;
  }

  async listStockIdsWithNotes(): Promise<readonly string[]> {
    return [...new Set([...this.items.values()].map((note) => note.stockId))].sort();
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
