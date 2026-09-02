import {
  assertStrategyAutonomyActionInvariants,
  assertStrategyAutonomyActionTransition,
  InvariantError,
  type StrategyAutonomyAction,
  type StrategyAutonomyActionRepository,
} from '@luoome/core';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, strategyAutonomyActions } from '../../schema/index.js';

type Row = typeof strategyAutonomyActions.$inferSelect;

const toAction = (row: Row): StrategyAutonomyAction => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  strategyId: row.strategyId,
  ...(row.strategyVersionId === null ? {} : { strategyVersionId: row.strategyVersionId }),
  ...(row.evaluationSessionId === null ? {} : { evaluationSessionId: row.evaluationSessionId }),
  trigger: row.trigger,
  ...(row.ruleSnapshot === null ? {} : { ruleSnapshot: row.ruleSnapshot }),
  ...(row.aiNarrative === null ? {} : { aiNarrative: row.aiNarrative }),
  factReferences: [...row.factReferences],
  attempts: row.attempts,
  ...(row.lastError === null ? {} : { lastError: row.lastError }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
});

const values = (action: StrategyAutonomyAction) => ({
  id: action.id,
  kind: action.kind,
  status: action.status,
  strategyId: action.strategyId,
  strategyVersionId: action.strategyVersionId ?? null,
  evaluationSessionId: action.evaluationSessionId ?? null,
  trigger: action.trigger,
  ruleSnapshot: action.ruleSnapshot ?? null,
  aiNarrative: action.aiNarrative ?? null,
  factReferences: action.factReferences,
  attempts: action.attempts,
  lastError: action.lastError ?? null,
  createdAt: action.createdAt,
  updatedAt: action.updatedAt,
  completedAt: action.completedAt ?? null,
});

const changedRows = (result: unknown): number =>
  typeof result === 'object' && result !== null && 'changes' in result
    ? Number((result as { readonly changes: unknown }).changes)
    : 0;

export class DrizzleStrategyAutonomyActionRepository implements StrategyAutonomyActionRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(action: StrategyAutonomyAction): Promise<void> {
    assertStrategyAutonomyActionInvariants(action);
    const existing = this.db
      .select()
      .from(strategyAutonomyActions)
      .where(eq(strategyAutonomyActions.id, action.id))
      .get();
    if (
      existing !== undefined &&
      existing.kind === 'publish-version' &&
      action.kind === 'publish-version' &&
      existing.strategyVersionId !== action.strategyVersionId
    ) {
      throw new InvariantError('publish-version 的 strategyVersionId 在动作创建后不可变');
    }
    this.db
      .insert(strategyAutonomyActions)
      .values(values(action))
      .onConflictDoUpdate({ target: strategyAutonomyActions.id, set: values(action) })
      .run();
  }

  async findById(id: string): Promise<StrategyAutonomyAction | null> {
    const row = this.db
      .select()
      .from(strategyAutonomyActions)
      .where(eq(strategyAutonomyActions.id, id))
      .get();
    return row === undefined ? null : toAction(row);
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
    const rows = this.db
      .select()
      .from(strategyAutonomyActions)
      .where(
        and(
          ...(filter.strategyId === undefined
            ? []
            : [eq(strategyAutonomyActions.strategyId, filter.strategyId)]),
          ...(filter.kind === undefined ? [] : [eq(strategyAutonomyActions.kind, filter.kind)]),
          ...(filter.status === undefined
            ? []
            : [eq(strategyAutonomyActions.status, filter.status)]),
          ...(filter.since === undefined
            ? []
            : [gte(strategyAutonomyActions.createdAt, filter.since)]),
        ),
      )
      .orderBy(desc(strategyAutonomyActions.createdAt), desc(strategyAutonomyActions.id))
      .all();
    const actions = rows.map(toAction);
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
    const current = await this.findById(input.id);
    if (current === null || current.status !== input.expectedStatus) return null;
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
    // WHERE 带 expectedStatus：并发转移先落库时本更新影响 0 行，调用方按 null 处理。
    const result = this.db
      .update(strategyAutonomyActions)
      .set({
        status: next.status,
        updatedAt: next.updatedAt,
        completedAt: next.completedAt ?? null,
        ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
        ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
      })
      .where(
        and(
          eq(strategyAutonomyActions.id, input.id),
          eq(strategyAutonomyActions.status, input.expectedStatus),
        ),
      )
      .run();
    return changedRows(result) === 0 ? null : next;
  }
}
