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
          (item.baselineAt?.getTime() ?? 0) >= from &&
          (item.baselineAt?.getTime() ?? 0) <= to,
      )
      .sort((a, b) => (b.baselineAt?.getTime() ?? 0) - (a.baselineAt?.getTime() ?? 0))
      .slice(0, input.limit ?? Number.POSITIVE_INFINITY);
  }
}
