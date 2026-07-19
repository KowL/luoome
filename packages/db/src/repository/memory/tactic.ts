import {
  assertTacticInvariants,
  type Tactic,
  type TacticRepository,
  type TacticSignal,
} from '@luoome/core';

/** Tactic 的 in-memory 实现。Key 用 tactic.id。 */
export class InMemoryTacticRepository implements TacticRepository {
  private readonly tactics = new Map<string, Tactic>();
  private readonly signals: TacticSignal[] = [];

  put(tactic: Tactic): void {
    assertTacticInvariants(tactic);
    this.tactics.set(tactic.id, tactic);
  }

  async save(tactic: Tactic): Promise<void> {
    this.put(tactic);
  }

  async findById(id: string): Promise<Tactic | null> {
    return this.findByIdSync(id);
  }

  /** 同步版（createInMemoryRepos 自动灌种时用，避免 await 链）。 */
  findByIdSync(id: string): Tactic | null {
    return this.tactics.get(id) ?? null;
  }

  async list(
    filter: { readonly tag?: Tactic['tag']; readonly source?: Tactic['source'] } = {},
  ): Promise<readonly Tactic[]> {
    const all = [...this.tactics.values()].sort((a, b) => a.id.localeCompare(b.id));
    return all.filter((t) => {
      if (filter.tag !== undefined && t.tag !== filter.tag) return false;
      if (filter.source !== undefined && t.source !== filter.source) return false;
      return true;
    });
  }

  async saveSignal(signal: TacticSignal): Promise<void> {
    // 去重：同 (tacticId, stockId, ts) 的旧信号替换
    const idx = this.signals.findIndex(
      (s) =>
        s.tacticId === signal.tacticId &&
        s.stockId === signal.stockId &&
        s.ts.getTime() === signal.ts.getTime(),
    );
    if (idx >= 0) {
      this.signals[idx] = signal;
    } else {
      this.signals.push(signal);
    }
  }

  async signalsByTactic(tacticId: string, since?: Date): Promise<readonly TacticSignal[]> {
    const sinceMs = since?.getTime() ?? Number.NEGATIVE_INFINITY;
    return this.signals
      .filter((s) => s.tacticId === tacticId && s.ts.getTime() >= sinceMs)
      .sort((a, b) => b.ts.getTime() - a.ts.getTime());
  }

  async signalsByStock(stockId: string, since?: Date): Promise<readonly TacticSignal[]> {
    const sinceMs = since?.getTime() ?? Number.NEGATIVE_INFINITY;
    return this.signals
      .filter((s) => s.stockId === stockId && s.ts.getTime() >= sinceMs)
      .sort((a, b) => b.ts.getTime() - a.ts.getTime());
  }
}
