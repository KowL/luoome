import {
  assertWorkflowRunInvariants,
  type ProviderStatus,
  type StrategyDailyCycleAuditQuery,
  type WorkflowRun,
  type WorkflowRunRepository,
} from '@luoome/core';
import { and, desc, eq, gte, inArray, lt, lte, or, type SQL, sql } from 'drizzle-orm';
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
    this.db
      .insert(workflowRuns)
      .values(row)
      .onConflictDoUpdate({
        target: workflowRuns.id,
        set: row,
      })
      .run();
  }

  async claim(
    run: WorkflowRun,
    retry?: { readonly staleRunningBefore: Date; readonly failedRetryBefore: Date },
  ): Promise<boolean> {
    assertWorkflowRunInvariants(run);
    if (run.status !== 'running') return false;
    const inserted = this.db
      .insert(workflowRuns)
      .values(toRow(run))
      .onConflictDoNothing()
      .returning({ id: workflowRuns.id })
      .get();
    if (inserted !== undefined) return true;
    if (retry === undefined) return false;
    const reclaimed = this.db
      .update(workflowRuns)
      .set(toRow(run))
      .where(
        and(
          eq(workflowRuns.id, run.id),
          or(
            and(
              eq(workflowRuns.status, 'running'),
              lt(workflowRuns.startedAt, retry.staleRunningBefore),
            ),
            and(
              eq(workflowRuns.status, 'failed'),
              lt(workflowRuns.finishedAt, retry.failedRetryBefore),
            ),
          ),
        ),
      )
      .returning({ id: workflowRuns.id })
      .get();
    return reclaimed !== undefined;
  }

  async finishClaim(run: WorkflowRun, claimToken: string): Promise<boolean> {
    assertWorkflowRunInvariants(run);
    if (run.status === 'running' || run.inputSummary?.claimToken !== claimToken) return false;
    const updated = this.db
      .update(workflowRuns)
      .set(toRow(run))
      .where(
        and(
          eq(workflowRuns.id, run.id),
          eq(workflowRuns.status, 'running'),
          sql`json_extract(${workflowRuns.inputSummary}, '$.claimToken') = ${claimToken}`,
        ),
      )
      .returning({ id: workflowRuns.id })
      .get();
    return updated !== undefined;
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

  async listAccountPlanBatches(date: string): Promise<readonly WorkflowRun[]> {
    return this.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workflowName, 'account-plan-batch'),
          sql`json_extract(${workflowRuns.inputSummary}, '$.date') = ${date}`,
        ),
      )
      .orderBy(desc(workflowRuns.startedAt), desc(workflowRuns.id))
      .all()
      .map(toWorkflowRun);
  }

  async listStrategyDailyCycleAudits(
    query: StrategyDailyCycleAuditQuery = {},
  ): Promise<readonly WorkflowRun[]> {
    const conditions: SQL[] = [eq(workflowRuns.workflowName, 'strategy-daily-cycle')];
    if (query.strategyId !== undefined) {
      conditions.push(
        sql`json_extract(${workflowRuns.inputSummary}, '$.strategyId') = ${query.strategyId}`,
      );
    }
    if (query.scheduleId !== undefined) {
      conditions.push(
        sql`json_extract(${workflowRuns.inputSummary}, '$.scheduleId') = ${query.scheduleId}`,
      );
    }
    if (query.statuses !== undefined) {
      conditions.push(
        query.statuses.length === 0 ? sql`0` : inArray(workflowRuns.status, [...query.statuses]),
      );
    }
    const dataAsOfJulian = sql<number>`coalesce(
      julianday(json_extract(${workflowRuns.inputSummary}, '$.dataAsOf')),
      julianday(${workflowRuns.startedAt} / 1000.0, 'unixepoch')
    )`;
    if (query.since !== undefined) {
      conditions.push(gte(dataAsOfJulian, sql<number>`julianday(${query.since.toISOString()})`));
    }
    if (query.until !== undefined) {
      conditions.push(lte(dataAsOfJulian, sql<number>`julianday(${query.until.toISOString()})`));
    }
    return this.db
      .select()
      .from(workflowRuns)
      .where(and(...conditions))
      .orderBy(desc(workflowRuns.startedAt), desc(workflowRuns.id))
      .limit(query.limit ?? 50)
      .offset(query.offset ?? 0)
      .all()
      .map(toWorkflowRun);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(workflowRuns).where(eq(workflowRuns.id, id)).run();
  }
}
