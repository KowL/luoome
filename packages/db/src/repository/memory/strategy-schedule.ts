import {
  assertStrategyScheduleInvariants,
  InvariantError,
  type StrategySchedule,
  type StrategyScheduleRepository,
} from '@luoome/core';

interface Lease {
  readonly owner: string;
  readonly until: Date;
}

export class InMemoryStrategyScheduleRepository implements StrategyScheduleRepository {
  private readonly items = new Map<string, StrategySchedule>();
  private readonly leases = new Map<string, Lease>();

  put(schedule: StrategySchedule): void {
    assertStrategyScheduleInvariants(schedule);
    const conflicting = [...this.items.values()].find(
      (item) => item.strategyId === schedule.strategyId && item.id !== schedule.id,
    );
    if (conflicting !== undefined) throw new InvariantError('Strategy 只能有一条 schedule');
    this.items.set(schedule.id, schedule);
  }

  async save(schedule: StrategySchedule): Promise<void> {
    this.put(schedule);
    this.leases.delete(schedule.id);
  }

  async findById(id: string): Promise<StrategySchedule | null> {
    return this.items.get(id) ?? null;
  }

  async findByStrategyId(strategyId: string): Promise<StrategySchedule | null> {
    return [...this.items.values()].find((item) => item.strategyId === strategyId) ?? null;
  }

  async list(input: { readonly enabledOnly?: boolean } = {}): Promise<readonly StrategySchedule[]> {
    return [...this.items.values()]
      .filter((item) => !input.enabledOnly || item.enabled)
      .sort((left, right) => left.strategyId.localeCompare(right.strategyId));
  }

  async claimDue(input: {
    readonly now: Date;
    readonly owner: string;
    readonly leaseUntil: Date;
    readonly limit: number;
  }): Promise<readonly StrategySchedule[]> {
    const due = [...this.items.values()]
      .filter((item) => {
        const lease = this.leases.get(item.id);
        return (
          item.enabled &&
          item.nextRunAt !== undefined &&
          item.nextRunAt.getTime() <= input.now.getTime() &&
          (lease === undefined || lease.until.getTime() <= input.now.getTime())
        );
      })
      .sort(
        (left, right) =>
          (left.nextRunAt?.getTime() ?? 0) - (right.nextRunAt?.getTime() ?? 0) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, input.limit);
    for (const schedule of due) {
      this.leases.set(schedule.id, { owner: input.owner, until: input.leaseUntil });
    }
    return due;
  }

  async finishClaim(input: {
    readonly id: string;
    readonly owner: string;
    readonly nextRunAt: Date;
    readonly updatedAt: Date;
    readonly lastRunId?: string;
  }): Promise<void> {
    const schedule = this.items.get(input.id);
    if (schedule === undefined) throw new InvariantError(`StrategySchedule 不存在: ${input.id}`);
    const lease = this.leases.get(input.id);
    if (lease?.owner !== input.owner)
      throw new InvariantError('StrategySchedule lease owner 不匹配');
    const next: StrategySchedule = {
      ...schedule,
      nextRunAt: input.nextRunAt,
      updatedAt: input.updatedAt,
      ...(input.lastRunId === undefined ? {} : { lastRunId: input.lastRunId }),
    };
    assertStrategyScheduleInvariants(next);
    this.items.set(next.id, next);
    this.leases.delete(next.id);
  }
}
