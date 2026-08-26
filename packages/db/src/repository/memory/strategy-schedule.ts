import {
  assertStrategyScheduleInvariants,
  InvariantError,
  type StrategySchedule,
  type StrategyScheduleClaim,
  type StrategyScheduleRepository,
} from '@luoome/core';

interface Lease {
  readonly owner: string;
  readonly until: Date;
  readonly fence: number;
  readonly heartbeatAt: Date;
}

export class InMemoryStrategyScheduleRepository implements StrategyScheduleRepository {
  private readonly items = new Map<string, StrategySchedule>();
  private readonly leases = new Map<string, Lease>();
  private readonly nextFences = new Map<string, number>();

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

  async removeByStrategyId(strategyId: string): Promise<void> {
    for (const [id, schedule] of this.items) {
      if (schedule.strategyId !== strategyId) continue;
      this.items.delete(id);
      this.leases.delete(id);
      this.nextFences.delete(id);
    }
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
      const fence = (this.nextFences.get(schedule.id) ?? 0) + 1;
      this.nextFences.set(schedule.id, fence);
      this.leases.set(schedule.id, {
        owner: input.owner,
        until: input.leaseUntil,
        fence,
        heartbeatAt: input.now,
      });
    }
    return due;
  }

  async claimDueWithFence(input: {
    readonly now: Date;
    readonly owner: string;
    readonly leaseUntil: Date;
    readonly limit: number;
  }): Promise<readonly StrategyScheduleClaim[]> {
    const schedules = await this.claimDue(input);
    return schedules.flatMap((schedule) => {
      const lease = this.leases.get(schedule.id);
      if (lease === undefined) return [];
      return [
        {
          schedule,
          token: {
            scheduleId: schedule.id,
            owner: lease.owner,
            fence: lease.fence,
            leaseUntil: lease.until,
          },
        },
      ];
    });
  }

  async claimByStrategyIdWithFence(input: {
    readonly strategyId: string;
    readonly now: Date;
    readonly owner: string;
    readonly leaseUntil: Date;
  }): Promise<StrategyScheduleClaim | null> {
    const schedule = [...this.items.values()].find(
      (item) => item.strategyId === input.strategyId && item.enabled,
    );
    if (schedule === undefined) return null;
    const currentLease = this.leases.get(schedule.id);
    if (currentLease !== undefined && currentLease.until.getTime() > input.now.getTime()) {
      return null;
    }
    const fence = (this.nextFences.get(schedule.id) ?? 0) + 1;
    this.nextFences.set(schedule.id, fence);
    this.leases.set(schedule.id, {
      owner: input.owner,
      until: input.leaseUntil,
      fence,
      heartbeatAt: input.now,
    });
    return {
      schedule,
      token: {
        scheduleId: schedule.id,
        owner: input.owner,
        fence,
        leaseUntil: input.leaseUntil,
      },
    };
  }

  async renewClaim(input: {
    readonly id: string;
    readonly owner: string;
    readonly fence: number;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<boolean> {
    const lease = this.leases.get(input.id);
    if (
      lease === undefined ||
      lease.owner !== input.owner ||
      lease.fence !== input.fence ||
      lease.until.getTime() <= input.now.getTime()
    ) {
      return false;
    }
    this.leases.set(input.id, { ...lease, until: input.leaseUntil, heartbeatAt: input.now });
    return true;
  }

  async finishClaim(input: {
    readonly id: string;
    readonly owner: string;
    readonly fence?: number;
    readonly nextRunAt: Date;
    readonly updatedAt: Date;
    readonly lastRunId?: string;
  }): Promise<void> {
    const schedule = this.items.get(input.id);
    if (schedule === undefined) throw new InvariantError(`StrategySchedule 不存在: ${input.id}`);
    const lease = this.leases.get(input.id);
    if (
      lease?.owner !== input.owner ||
      (input.fence !== undefined && lease.fence !== input.fence) ||
      lease.until.getTime() <= input.updatedAt.getTime()
    )
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
