import {
  type CorporateActionEventRepository,
  type CorporateActionEventRevision,
  CorporateActionEventRevisionSchema,
} from '@luoome/core';

const keyOf = (revision: CorporateActionEventRevision): string =>
  `${revision.stockId}|${revision.exDate.getTime()}|${revision.sourceRecordId}|${revision.recordedAt.getTime()}|${revision.contentHash}`;

/** CorporateActionEventRevision 的 in-memory 实现；同日多事件并存，主键幂等。 */
export class InMemoryCorporateActionEventRepository implements CorporateActionEventRepository {
  private readonly revisions = new Map<string, CorporateActionEventRevision>();

  async saveMany(revisions: readonly CorporateActionEventRevision[]): Promise<void> {
    for (const input of revisions) {
      const parsed = CorporateActionEventRevisionSchema.parse(input);
      const key = keyOf(parsed);
      if (!this.revisions.has(key)) this.revisions.set(key, parsed);
    }
  }

  async listRevisions(input: {
    readonly stockId: string;
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly CorporateActionEventRevision[]> {
    return [...this.revisions.values()]
      .filter(
        (revision) =>
          revision.stockId === input.stockId &&
          (input.from === undefined || revision.exDate >= input.from) &&
          (input.to === undefined || revision.exDate <= input.to) &&
          (input.recordedAt === undefined || revision.recordedAt <= input.recordedAt),
      )
      .sort(
        (left, right) =>
          left.exDate.getTime() - right.exDate.getTime() ||
          left.recordedAt.getTime() - right.recordedAt.getTime() ||
          left.sourceRecordId.localeCompare(right.sourceRecordId) ||
          left.contentHash.localeCompare(right.contentHash),
      );
  }

  async listRevisionsForStocks(input: {
    readonly stockIds: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly CorporateActionEventRevision[]> {
    const stockIds = new Set(input.stockIds);
    return [...this.revisions.values()]
      .filter(
        (revision) =>
          stockIds.has(revision.stockId) &&
          (input.from === undefined || revision.exDate >= input.from) &&
          (input.to === undefined || revision.exDate <= input.to) &&
          (input.recordedAt === undefined || revision.recordedAt <= input.recordedAt),
      )
      .sort(
        (left, right) =>
          left.stockId.localeCompare(right.stockId) ||
          left.exDate.getTime() - right.exDate.getTime() ||
          left.recordedAt.getTime() - right.recordedAt.getTime() ||
          left.sourceRecordId.localeCompare(right.sourceRecordId) ||
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
      if (minDate === null || revision.exDate.getTime() < minDate.getTime()) {
        minDate = revision.exDate;
      }
      if (maxDate === null || revision.exDate.getTime() > maxDate.getTime()) {
        maxDate = revision.exDate;
      }
    }
    return { rows, minDate, maxDate };
  }
}
