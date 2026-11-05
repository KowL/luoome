import {
  type RawDailyBarRepository,
  type RawDailyBarRevision,
  RawDailyBarRevisionSchema,
} from '@luoome/core';

const keyOf = (revision: RawDailyBarRevision): string =>
  `${revision.stockId}|${revision.date.getTime()}|${revision.recordedAt.getTime()}|${revision.contentHash}`;

/** RawDailyBarRevision 的 in-memory 实现；append-only + 主键幂等，对齐 Drizzle。 */
export class InMemoryRawDailyBarRepository implements RawDailyBarRepository {
  private readonly revisions = new Map<string, RawDailyBarRevision>();

  async saveMany(revisions: readonly RawDailyBarRevision[]): Promise<void> {
    for (const input of revisions) {
      const parsed = RawDailyBarRevisionSchema.parse(input);
      const key = keyOf(parsed);
      if (!this.revisions.has(key)) this.revisions.set(key, parsed);
    }
  }

  async listRevisions(input: {
    readonly stockId: string;
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly RawDailyBarRevision[]> {
    return [...this.revisions.values()]
      .filter(
        (revision) =>
          revision.stockId === input.stockId &&
          (input.from === undefined || revision.date >= input.from) &&
          (input.to === undefined || revision.date <= input.to) &&
          (input.recordedAt === undefined || revision.recordedAt <= input.recordedAt),
      )
      .sort(
        (left, right) =>
          left.date.getTime() - right.date.getTime() ||
          left.recordedAt.getTime() - right.recordedAt.getTime() ||
          left.contentHash.localeCompare(right.contentHash),
      );
  }

  async listRevisionsForStocks(input: {
    readonly stockIds: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly RawDailyBarRevision[]> {
    const stockIds = new Set(input.stockIds);
    return [...this.revisions.values()]
      .filter(
        (revision) =>
          stockIds.has(revision.stockId) &&
          (input.from === undefined || revision.date >= input.from) &&
          (input.to === undefined || revision.date <= input.to) &&
          (input.recordedAt === undefined || revision.recordedAt <= input.recordedAt),
      )
      .sort(
        (left, right) =>
          left.stockId.localeCompare(right.stockId) ||
          left.date.getTime() - right.date.getTime() ||
          left.recordedAt.getTime() - right.recordedAt.getTime() ||
          left.contentHash.localeCompare(right.contentHash),
      );
  }

  async summarizeArtifact(input: {
    readonly dumpId: string;
    readonly artifactSha256: string;
  }): Promise<{
    readonly rows: number;
    readonly minDate: Date | null;
    readonly maxDate: Date | null;
  }> {
    let rows = 0;
    let minDate: Date | null = null;
    let maxDate: Date | null = null;
    for (const revision of this.revisions.values()) {
      if (revision.dumpId !== input.dumpId || revision.artifactSha256 !== input.artifactSha256) {
        continue;
      }
      rows += 1;
      if (minDate === null || revision.date.getTime() < minDate.getTime()) minDate = revision.date;
      if (maxDate === null || revision.date.getTime() > maxDate.getTime()) maxDate = revision.date;
    }
    return { rows, minDate, maxDate };
  }
}
