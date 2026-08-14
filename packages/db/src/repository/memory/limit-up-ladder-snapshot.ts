import {
  type LimitUpLadder,
  LimitUpLadderSchema,
  type LimitUpLadderSnapshotRepository,
  type LimitUpLadderSource,
} from '@luoome/core';

const keyOf = (date: string, source: LimitUpLadderSource): string => `${source}\0${date}`;

export class InMemoryLimitUpLadderSnapshotRepository implements LimitUpLadderSnapshotRepository {
  private readonly snapshots = new Map<string, LimitUpLadder>();

  async save(snapshot: LimitUpLadder): Promise<void> {
    const parsed = LimitUpLadderSchema.parse(snapshot);
    this.snapshots.set(keyOf(parsed.date, parsed.source), parsed);
  }

  async findByDate(input: {
    readonly date: string;
    readonly source: LimitUpLadderSource;
  }): Promise<LimitUpLadder | null> {
    return this.snapshots.get(keyOf(input.date, input.source)) ?? null;
  }
}
