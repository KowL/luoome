import {
  assertSignalObservationInvariants,
  type SignalObservation,
  type SignalObservationRepository,
} from '@luoome/core';

export class InMemorySignalObservationRepository implements SignalObservationRepository {
  private readonly items = new Map<string, SignalObservation>();

  put(observation: SignalObservation): void {
    assertSignalObservationInvariants(observation);
    this.items.set(observation.id, observation);
  }

  async save(observation: SignalObservation): Promise<void> {
    this.put(observation);
  }
  async findById(id: string): Promise<SignalObservation | null> {
    return this.items.get(id) ?? null;
  }
  async listBySources(
    input: Parameters<SignalObservationRepository['listBySources']>[0],
  ): Promise<readonly SignalObservation[]> {
    if (input.sourceIds.length === 0) return [];
    const sourceIds = new Set(input.sourceIds);
    const horizons = input.horizons === undefined ? undefined : new Set(input.horizons);
    return [...this.items.values()]
      .filter(
        (item) =>
          sourceIds.has(item.sourceId) &&
          (input.sourceKind === undefined || item.sourceKind === input.sourceKind) &&
          (horizons === undefined || horizons.has(item.horizon)),
      )
      .sort(
        (left, right) =>
          (right.baselineAt?.getTime() ?? Number.NEGATIVE_INFINITY) -
            (left.baselineAt?.getTime() ?? Number.NEGATIVE_INFINITY) ||
          right.id.localeCompare(left.id),
      );
  }
  async list(
    input: Parameters<SignalObservationRepository['list']>[0] = {},
  ): Promise<readonly SignalObservation[]> {
    const from = input.from?.getTime() ?? Number.NEGATIVE_INFINITY;
    const to = input.to?.getTime() ?? Number.POSITIVE_INFINITY;
    return [...this.items.values()]
      .filter(
        (item) =>
          (input.status === undefined || item.status === input.status) &&
          (input.sourceKind === undefined || item.sourceKind === input.sourceKind) &&
          (input.sourceIds === undefined || input.sourceIds.includes(item.sourceId)) &&
          (input.horizons === undefined || input.horizons.includes(item.horizon)) &&
          (item.baselineAt?.getTime() ?? 0) >= from &&
          (item.baselineAt?.getTime() ?? 0) <= to &&
          (input.dueBefore === undefined ||
            (item.dueAt?.getTime() ?? item.baselineAt?.getTime() ?? 0) <=
              input.dueBefore.getTime()) &&
          (input.retryReadyAt === undefined ||
            item.nextAttemptAt === undefined ||
            item.nextAttemptAt.getTime() <= input.retryReadyAt.getTime()),
      )
      .sort((a, b) => {
        if (input.order === 'due-first') {
          return (
            (a.dueAt?.getTime() ?? a.baselineAt?.getTime() ?? 0) -
              (b.dueAt?.getTime() ?? b.baselineAt?.getTime() ?? 0) ||
            (a.baselineAt?.getTime() ?? 0) - (b.baselineAt?.getTime() ?? 0) ||
            a.id.localeCompare(b.id)
          );
        }
        return (b.baselineAt?.getTime() ?? 0) - (a.baselineAt?.getTime() ?? 0);
      })
      .slice(0, input.limit ?? Number.POSITIVE_INFINITY);
  }

  async removeBySources(
    sourceKind: SignalObservation['sourceKind'],
    sourceIds: readonly string[],
  ): Promise<void> {
    const ids = new Set(sourceIds);
    for (const [id, item] of this.items) {
      if (item.sourceKind === sourceKind && ids.has(item.sourceId)) this.items.delete(id);
    }
  }
}
