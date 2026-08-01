import type { ResearchVaultSyncRun, ResearchVaultSyncRunRepository } from '@luoome/core';
export class InMemoryResearchVaultSyncRunRepository implements ResearchVaultSyncRunRepository {
  private readonly items = new Map<string, ResearchVaultSyncRun>();
  async save(run: ResearchVaultSyncRun) { this.items.set(run.id, structuredClone(run)); }
  async findById(id: string) { const value = this.items.get(id); return value ? structuredClone(value) : null; }
  async list(vaultId: string, limit = 50) { return [...this.items.values()].filter((x) => x.vaultId === vaultId).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()).slice(0, limit).map((x) => structuredClone(x)); }
}
