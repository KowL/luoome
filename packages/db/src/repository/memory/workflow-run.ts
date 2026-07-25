import {
  assertWorkflowRunInvariants,
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

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
