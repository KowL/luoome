import type { ResearchVaultSyncRun, ResearchVaultSyncRunRepository } from '@luoome/core';
import { desc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '../../client.js';
import { researchVaultSyncRuns } from '../../schema/index.js';

const fromRow = (r: typeof researchVaultSyncRuns.$inferSelect): ResearchVaultSyncRun => ({
  ...r,
  mode: r.mode as ResearchVaultSyncRun['mode'],
  status: r.status as ResearchVaultSyncRun['status'],
  finishedAt: r.finishedAt ?? undefined,
  error: r.error ?? undefined,
});
export class DrizzleResearchVaultSyncRunRepository implements ResearchVaultSyncRunRepository {
  constructor(private readonly db: DrizzleDb) {}
  async save(run: ResearchVaultSyncRun) {
    this.db
      .insert(researchVaultSyncRuns)
      .values({ ...run, finishedAt: run.finishedAt ?? null, error: run.error ?? null })
      .onConflictDoUpdate({
        target: researchVaultSyncRuns.id,
        set: { ...run, finishedAt: run.finishedAt ?? null, error: run.error ?? null },
      })
      .run();
  }
  async findById(id: string) {
    const row = this.db
      .select()
      .from(researchVaultSyncRuns)
      .where(eq(researchVaultSyncRuns.id, id))
      .get();
    return row ? fromRow(row) : null;
  }
  async list(vaultId: string, limit = 50) {
    return this.db
      .select()
      .from(researchVaultSyncRuns)
      .where(eq(researchVaultSyncRuns.vaultId, vaultId))
      .orderBy(desc(researchVaultSyncRuns.startedAt))
      .limit(limit)
      .all()
      .map(fromRow);
  }
}
