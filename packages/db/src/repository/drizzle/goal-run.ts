import {
  type AnalysisRepository,
  applyGoalCommand,
  cancelGoalRun,
  type GoalRun,
  type GoalRunRepository,
  GoalRunSchema,
  InvariantError,
} from '@luoome/core';
import { and, eq } from 'drizzle-orm';
import type { DrizzleDatabase } from '../../database.js';
import { goalRuns } from '../../schema/goal-run.js';
import type { Schema } from '../../schema/index.js';
export class DrizzleGoalRunRepository implements GoalRunRepository {
  constructor(
    private readonly db: DrizzleDatabase<Schema>,
    private readonly analysis: AnalysisRepository,
  ) {}
  private read(accountId: string, id: string): GoalRun | null {
    const row = this.db
      .select()
      .from(goalRuns)
      .where(and(eq(goalRuns.accountId, accountId), eq(goalRuns.id, id)))
      .get();
    return row ? GoalRunSchema.parse(JSON.parse(row.recordJson)) : null;
  }
  private write(run: GoalRun): void {
    this.db
      .update(goalRuns)
      .set({ status: run.status, version: run.version, recordJson: JSON.stringify(run) })
      .where(and(eq(goalRuns.id, run.id), eq(goalRuns.accountId, run.accountId)))
      .run();
  }
  async create(input: GoalRun): Promise<{ run: GoalRun; replayed: boolean }> {
    const run = GoalRunSchema.parse(input);
    return this.db.transaction(
      () => {
        const row = this.db
          .select()
          .from(goalRuns)
          .where(and(eq(goalRuns.accountId, run.accountId), eq(goalRuns.requestId, run.requestId)))
          .get();
        if (row) {
          const existing = GoalRunSchema.parse(JSON.parse(row.recordJson));
          if (existing.requestHash !== run.requestHash)
            throw new InvariantError('goal_request_conflict');
          return { run: existing, replayed: true };
        }
        if (run.status !== 'pending' || run.version !== 0)
          throw new InvariantError('goal_initial_state_required');
        this.db
          .insert(goalRuns)
          .values({
            id: run.id,
            accountId: run.accountId,
            requestId: run.requestId,
            status: run.status,
            version: run.version,
            recordJson: JSON.stringify(run),
          })
          .run();
        return { run, replayed: false };
      },
      { behavior: 'immediate' },
    );
  }
  async find(accountId: string, id: string): Promise<GoalRun | null> {
    return this.read(accountId, id);
  }
  async apply(input: Parameters<GoalRunRepository['apply']>[0]): Promise<GoalRun | null> {
    const context =
      input.command.type === 'attempt'
        ? await this.analysis.findContext(input.accountId, input.command.attempt.contextId)
        : null;
    return this.db.transaction(
      () => {
        const run = this.read(input.accountId, input.id);
        if (
          !run ||
          run.version !== input.expectedVersion ||
          !['pending', 'running'].includes(run.status)
        )
          return null;
        const next = applyGoalCommand(run, input.command, input.now, context ?? undefined);
        this.write(next);
        return next;
      },
      { behavior: 'immediate' },
    );
  }
  async cancel(accountId: string, id: string, now: Date): Promise<GoalRun | null> {
    return this.db.transaction(
      () => {
        const run = this.read(accountId, id);
        const next = run ? cancelGoalRun(run, now) : null;
        if (next) this.write(next);
        return next;
      },
      { behavior: 'immediate' },
    );
  }
}
