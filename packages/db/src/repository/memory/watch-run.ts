import { assertWatchRunInvariants, type WatchRun, type WatchRunRepository } from '@luoome/core';

export class InMemoryWatchRunRepository implements WatchRunRepository {
  private readonly items = new Map<string, WatchRun>();

  put(run: WatchRun): void {
    assertWatchRunInvariants(run);
    this.items.set(run.id, run);
  }

  async save(run: WatchRun): Promise<void> {
    this.put(run);
  }

  async findById(id: string): Promise<WatchRun | null> {
    return this.items.get(id) ?? null;
  }

  async latest(): Promise<WatchRun | null> {
    return (await this.listRecent(1))[0] ?? null;
  }

  async listRecent(limit = 50): Promise<readonly WatchRun[]> {
    return [...this.items.values()]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, limit);
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
