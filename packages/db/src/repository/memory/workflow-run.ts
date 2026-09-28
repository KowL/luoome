import {
  assertWorkflowRunInvariants,
  decodeStrategyDailyCycleAudit,
  type StrategyDailyCycleAuditQuery,
  type WorkflowRun,
  type WorkflowRunRepository,
} from '@luoome/core';

/** WorkflowRun in-memory 实现（ruo 迁移 §3.4）。save 同 id 为 upsert。 */
export class InMemoryWorkflowRunRepository implements WorkflowRunRepository {
  private readonly items = new Map<string, WorkflowRun>();

  put(run: WorkflowRun): void {
    assertWorkflowRunInvariants(run);
    this.items.set(run.id, run);
  }

  async save(run: WorkflowRun): Promise<void> {
    this.put(run);
  }

  async claim(
    run: WorkflowRun,
    retry?: { readonly staleRunningBefore: Date; readonly failedRetryBefore: Date },
  ): Promise<boolean> {
    assertWorkflowRunInvariants(run);
    if (run.status !== 'running') return false;
    const current = this.items.get(run.id);
    if (
      current !== undefined &&
      (retry === undefined ||
        !(
          (current.status === 'running' && current.startedAt < retry.staleRunningBefore) ||
          (current.status === 'failed' &&
            current.finishedAt !== undefined &&
            current.finishedAt < retry.failedRetryBefore)
        ))
    )
      return false;
    this.items.set(run.id, run);
    return true;
  }

  async finishClaim(run: WorkflowRun, claimToken: string): Promise<boolean> {
    assertWorkflowRunInvariants(run);
    const current = this.items.get(run.id);
    if (
      run.status === 'running' ||
      run.inputSummary?.claimToken !== claimToken ||
      current?.status !== 'running' ||
      current.inputSummary?.claimToken !== claimToken
    )
      return false;
    this.items.set(run.id, run);
    return true;
  }

  async findById(id: string): Promise<WorkflowRun | null> {
    return this.items.get(id) ?? null;
  }

  async listRecent(
    opts: {
      readonly workflowName?: string;
      readonly status?: WorkflowRun['status'];
      readonly since?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<readonly WorkflowRun[]> {
    const sinceMs = opts.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    const limit = opts.limit ?? 50;
    return [...this.items.values()]
      .filter((r) => opts.workflowName === undefined || r.workflowName === opts.workflowName)
      .filter((r) => opts.status === undefined || r.status === opts.status)
      .filter((r) => r.startedAt.getTime() >= sinceMs)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
  }

  async listAccountPlanBatches(date: string): Promise<readonly WorkflowRun[]> {
    return [...this.items.values()]
      .filter((run) => run.workflowName === 'account-plan-batch' && run.inputSummary?.date === date)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.id.localeCompare(a.id));
  }

  async listStrategyDailyCycleAudits(
    query: StrategyDailyCycleAuditQuery = {},
  ): Promise<readonly WorkflowRun[]> {
    const sinceMs = query.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    const untilMs = query.until?.getTime() ?? Number.POSITIVE_INFINITY;
    const statuses = query.statuses === undefined ? undefined : new Set(query.statuses);
    return [...this.items.values()]
      .flatMap((run) => decodeStrategyDailyCycleAudit(run) ?? [])
      .filter((audit) => query.strategyId === undefined || audit.strategyId === query.strategyId)
      .filter((audit) => query.scheduleId === undefined || audit.scheduleId === query.scheduleId)
      .filter((audit) => statuses === undefined || statuses.has(audit.run.status))
      .filter((audit) => {
        const dataAsOfMs = audit.dataAsOf.getTime();
        return dataAsOfMs >= sinceMs && dataAsOfMs <= untilMs;
      })
      .sort((left, right) => {
        const byStartedAt = right.run.startedAt.getTime() - left.run.startedAt.getTime();
        return byStartedAt !== 0 ? byStartedAt : right.run.id.localeCompare(left.run.id);
      })
      .slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50))
      .map((audit) => audit.run);
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
