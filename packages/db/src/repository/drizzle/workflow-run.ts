import {
  assertWorkflowRunInvariants,
  type ProviderStatus,
  type WorkflowRun,
  type WorkflowRunRepository,
} from '@luoome/core';
import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, workflowRuns } from '../../schema/index.js';

type RunRow = typeof workflowRuns.$inferSelect;

const toWorkflowRun = (row: RunRow): WorkflowRun => ({
  id: row.id,
  workflowName: row.workflowName,
  mode: row.mode,
  status: row.status,
  startedAt: row.startedAt,
  ...(row.finishedAt !== null ? { finishedAt: row.finishedAt } : {}),
  ...(row.inputSummary !== null
    ? { inputSummary: row.inputSummary as Record<string, unknown> }
    : {}),
  ...(row.outputSummary !== null
    ? { outputSummary: row.outputSummary as Record<string, unknown> }
    : {}),
  providerStatuses: [...(row.providerStatuses as ProviderStatus[])],
  ...(row.error !== null ? { error: row.error } : {}),
});

const toRow = (run: WorkflowRun): typeof workflowRuns.$inferInsert => ({
  id: run.id,
  workflowName: run.workflowName,
  mode: run.mode,
  status: run.status,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt ?? null,
  inputSummary: run.inputSummary ?? null,
  outputSummary: run.outputSummary ?? null,
  providerStatuses: [...run.providerStatuses],
  error: run.error ?? null,
});

/** WorkflowRun Drizzle 实现（ruo 迁移 §3.4）。save 同 id 为 upsert（running → terminal）。 */
export class DrizzleWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(run: WorkflowRun): Promise<void> {
    assertWorkflowRunInvariants(run);
    const row = toRow(run);
    this.db.insert(workflowRuns).values(row).onConflictDoUpdate({
      target: workflowRuns.id,
      set: row,
    }).run();
  }

  async findById(id: string): Promise<WorkflowRun | null> {
    const row = this.db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).get();
    return row === undefined ? null : toWorkflowRun(row);
  }

  async listRecent(
    opts: {
      readonly workflowName?: string;
      readonly status?: WorkflowRun['status'];
      readonly since?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<readonly WorkflowRun[]> {
    const conditions: SQL[] = [];
    if (opts.workflowName !== undefined) {
      conditions.push(eq(workflowRuns.workflowName, opts.workflowName));
    }
    if (opts.status !== undefined) conditions.push(eq(workflowRuns.status, opts.status));
    if (opts.since !== undefined) conditions.push(gte(workflowRuns.startedAt, opts.since));
    const where = conditions.length === 0 ? undefined : and(...conditions);
    return this.db
      .select()
      .from(workflowRuns)
      .where(where)
      .orderBy(desc(workflowRuns.startedAt))
      .limit(opts.limit ?? 50)
      .all()
      .map(toWorkflowRun);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(workflowRuns).where(eq(workflowRuns.id, id)).run();
  }
}
