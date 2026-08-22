import {
  assertFinancialFactInvariants,
  type FinancialFact,
  type FinancialFactRepository,
  InvariantError,
  resolveStrictPitFinancialVintage,
} from '@luoome/core';

const copy = <T>(value: T): T => structuredClone(value);

const logicalKey = (fact: FinancialFact): string =>
  [fact.source, fact.sourceRecordId, fact.sourceRevision, fact.contentHash].join('\u0000');

const assertSupersedes = (fact: FinancialFact, superseded: FinancialFact | undefined): void => {
  if (fact.supersedesId === undefined) return;
  if (superseded === undefined) {
    throw new InvariantError(
      `FinancialFact.supersedesId 未找到目标 revision: ${fact.supersedesId}`,
    );
  }
  if (
    superseded.stockId !== fact.stockId ||
    superseded.metricId !== fact.metricId ||
    superseded.periodType !== fact.periodType ||
    superseded.periodStart?.getTime() !== fact.periodStart?.getTime() ||
    superseded.periodEnd.getTime() !== fact.periodEnd.getTime()
  ) {
    throw new InvariantError(
      'FinancialFact.supersedesId 必须指向同 stock/metric/period 的 revision',
    );
  }
  if (superseded.revisionPublishedAt >= fact.revisionPublishedAt) {
    throw new InvariantError('FinancialFact.supersedesId 必须指向较早 revision');
  }
};

const compareFacts = (left: FinancialFact, right: FinancialFact): number =>
  left.stockId.localeCompare(right.stockId) ||
  left.metricId.localeCompare(right.metricId) ||
  left.periodEnd.getTime() - right.periodEnd.getTime() ||
  left.revisionPublishedAt.getTime() - right.revisionPublishedAt.getTime() ||
  left.sourceRevision.localeCompare(right.sourceRevision) ||
  left.recordedAt.getTime() - right.recordedAt.getTime() ||
  left.contentHash.localeCompare(right.contentHash) ||
  left.id.localeCompare(right.id);

/** FinancialFact 的 append-only in-memory 实现。 */
export class InMemoryFinancialFactRepository implements FinancialFactRepository {
  private readonly items = new Map<string, FinancialFact>();

  async appendMany(facts: readonly FinancialFact[]): Promise<void> {
    const parsed = facts.map((fact) => {
      const value = copy(fact);
      assertFinancialFactInvariants(value);
      return value;
    });
    const next = new Map(this.items);
    for (const fact of parsed) {
      assertSupersedes(
        fact,
        fact.supersedesId === undefined ? undefined : next.get(fact.supersedesId),
      );
      const byId = next.get(fact.id);
      if (byId !== undefined) {
        if (byId.contentHash !== fact.contentHash) {
          throw new InvariantError(`FinancialFact revision id 冲突且不得覆盖: ${fact.id}`);
        }
        continue;
      }
      const duplicate = [...next.values()].some(
        (existing) => logicalKey(existing) === logicalKey(fact),
      );
      if (duplicate) continue;
      next.set(fact.id, copy(fact));
    }
    this.items.clear();
    for (const [id, fact] of next) {
      this.items.set(id, fact);
    }
  }

  async listRevisions(input: {
    readonly stockIds: readonly string[];
    readonly metricIds?: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly FinancialFact[]> {
    const stockIds = new Set(input.stockIds);
    if (stockIds.size === 0) return [];
    const metricIds = input.metricIds === undefined ? undefined : new Set(input.metricIds);
    if (metricIds?.size === 0) return [];
    const from = input.from?.getTime();
    const to = input.to?.getTime();
    const recordedAt = input.recordedAt?.getTime();
    return [...this.items.values()]
      .filter(
        (fact) =>
          stockIds.has(fact.stockId) &&
          (metricIds === undefined || metricIds.has(fact.metricId)) &&
          (from === undefined || fact.periodEnd.getTime() >= from) &&
          (to === undefined || fact.periodEnd.getTime() <= to) &&
          (recordedAt === undefined || fact.recordedAt.getTime() <= recordedAt),
      )
      .sort(compareFacts)
      .map(copy);
  }

  async resolveVintage(input: {
    readonly stockIds: readonly string[];
    readonly metricIds: readonly string[];
    readonly asOf: Date;
    readonly policy: 'strict-pit-v1';
  }) {
    const facts = await this.listRevisions({
      stockIds: input.stockIds,
      metricIds: input.metricIds,
    });
    return resolveStrictPitFinancialVintage({ ...input, facts });
  }
}
