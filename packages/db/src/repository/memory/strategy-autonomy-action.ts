import {
  assertStrategyAutonomyActionInvariants,
  assertStrategyAutonomyActionTransition,
  InvariantError,
  type StrategyAutonomyAction,
  type StrategyAutonomyActionRepository,
} from '@luoome/core';

export class InMemoryStrategyAutonomyActionRepository implements StrategyAutonomyActionRepository {
  private readonly items = new Map<string, StrategyAutonomyAction>();

  async save(action: StrategyAutonomyAction): Promise<void> {
    assertStrategyAutonomyActionInvariants(action);
    const existing = this.items.get(action.id);
    if (
      existing !== undefined &&
      existing.kind === 'publish-version' &&
      action.kind === 'publish-version' &&
      existing.strategyVersionId !== action.strategyVersionId
    ) {
      throw new InvariantError('publish-version 的 strategyVersionId 在动作创建后不可变');
    }
    this.items.set(action.id, action);
  }

  async findById(id: string): Promise<StrategyAutonomyAction | null> {
    return this.items.get(id) ?? null;
  }

  async list(
    filter: {
      readonly strategyId?: string;
      readonly kind?: StrategyAutonomyAction['kind'];
      readonly status?: StrategyAutonomyAction['status'];
      readonly since?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<readonly StrategyAutonomyAction[]> {
    const actions = [...this.items.values()]
      .filter(
        (item) =>
          (filter.strategyId === undefined || item.strategyId === filter.strategyId) &&
          (filter.kind === undefined || item.kind === filter.kind) &&
          (filter.status === undefined || item.status === filter.status) &&
          (filter.since === undefined || item.createdAt >= filter.since),
      )
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
      );
    return filter.limit === undefined ? actions : actions.slice(0, filter.limit);
  }

  async updateStatus(input: {
    readonly id: string;
    readonly expectedStatus: StrategyAutonomyAction['status'];
    readonly status: StrategyAutonomyAction['status'];
    readonly updatedAt: Date;
    readonly completedAt?: Date;
    readonly lastError?: string;
    readonly attempts?: number;
  }): Promise<StrategyAutonomyAction | null> {
    const current = this.items.get(input.id);
    if (current === undefined || current.status !== input.expectedStatus) return null;
    assertStrategyAutonomyActionTransition(current.status, input.status);
    const next: StrategyAutonomyAction = {
      ...current,
      status: input.status,
      updatedAt: input.updatedAt,
      ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
      ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
      ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
    };
    assertStrategyAutonomyActionInvariants(next);
    this.items.set(input.id, next);
    return next;
  }
}
