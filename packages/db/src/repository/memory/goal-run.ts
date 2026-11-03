import {
  type AnalysisRepository,
  applyGoalCommand,
  cancelGoalRun,
  type GoalRun,
  type GoalRunRepository,
  GoalRunSchema,
  InvariantError,
} from '@luoome/core';
export class InMemoryGoalRunRepository implements GoalRunRepository {
  private readonly rows = new Map<string, GoalRun>();
  constructor(private readonly analysis: AnalysisRepository) {}
  async create(input: GoalRun): Promise<{ run: GoalRun; replayed: boolean }> {
    const run = GoalRunSchema.parse(input);
    const existing = [...this.rows.values()].find(
      (item) =>
        item.id === run.id ||
        (item.accountId === run.accountId && item.requestId === run.requestId),
    );
    if (existing) {
      if (
        existing.accountId !== run.accountId ||
        existing.requestId !== run.requestId ||
        existing.requestHash !== run.requestHash
      )
        throw new InvariantError('goal_request_conflict');
      return { run: structuredClone(existing), replayed: true };
    }
    if (run.status !== 'pending' || run.version !== 0)
      throw new InvariantError('goal_initial_state_required');
    this.rows.set(run.id, structuredClone(run));
    return { run: structuredClone(run), replayed: false };
  }
  async find(accountId: string, id: string): Promise<GoalRun | null> {
    const run = this.rows.get(id);
    return run?.accountId === accountId ? structuredClone(run) : null;
  }
  async apply(input: Parameters<GoalRunRepository['apply']>[0]): Promise<GoalRun | null> {
    const context =
      input.command.type === 'attempt'
        ? await this.analysis.findContext(input.accountId, input.command.attempt.contextId)
        : null;
    // Read the CAS version after the only async lookup, so cancellation fences this commit.
    const run = this.rows.get(input.id);
    if (
      !run ||
      run.accountId !== input.accountId ||
      run.version !== input.expectedVersion ||
      !['pending', 'running'].includes(run.status)
    )
      return null;
    const next = applyGoalCommand(run, input.command, input.now, context ?? undefined);
    this.rows.set(next.id, structuredClone(next));
    return structuredClone(next);
  }
  async cancel(accountId: string, id: string, now: Date): Promise<GoalRun | null> {
    const run = this.rows.get(id);
    if (!run || run.accountId !== accountId) return null;
    const next = cancelGoalRun(run, now);
    if (!next) return null;
    this.rows.set(id, structuredClone(next));
    return structuredClone(next);
  }
}
