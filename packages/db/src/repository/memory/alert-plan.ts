import { type AlertPlan, type AlertPlanRepository, assertAlertPlanInvariants } from '@luoome/core';

export class InMemoryAlertPlanRepository implements AlertPlanRepository {
  private readonly items = new Map<string, AlertPlan>();

  snapshotForExport(): AlertPlan[] {
    return structuredClone([...this.items.values()]);
  }

  async save(plan: AlertPlan): Promise<void> {
    this.put(plan);
  }

  put(plan: AlertPlan): void {
    assertAlertPlanInvariants(plan);
    this.items.set(plan.id, plan);
  }

  async findById(id: string): Promise<AlertPlan | null> {
    return this.items.get(id) ?? null;
  }

  async list(
    filter: { readonly enabledOnly?: boolean; readonly watchlistId?: string } = {},
  ): Promise<readonly AlertPlan[]> {
    return [...this.items.values()]
      .filter(
        (plan) =>
          (!filter.enabledOnly || plan.enabled) &&
          (filter.watchlistId === undefined || plan.watchlistId === filter.watchlistId),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async remove(id: string): Promise<void> {
    this.delete(id);
  }

  delete(id: string): void {
    this.items.delete(id);
  }
}
