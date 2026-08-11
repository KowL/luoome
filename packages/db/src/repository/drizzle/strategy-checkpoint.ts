import {
  InvariantError,
  type StrategyDataCheckpoint,
  type StrategyDataCheckpointMember,
  StrategyDataCheckpointMemberSchema,
  type StrategyDataCheckpointRepository,
  StrategyDataCheckpointSchema,
  type StrategyEvaluationDay,
  StrategyEvaluationDaySchema,
  type StrategyEvaluationRepository,
  type StrategyEvaluationSession,
  StrategyEvaluationSessionSchema,
} from '@luoome/core';
import { and, asc, desc, eq, lte, or } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import {
  type Schema,
  strategyDataCheckpointMembers,
  strategyDataCheckpoints,
  strategyEvaluationDays,
  strategyEvaluationSessions,
} from '../../schema/index.js';

type CheckpointRow = typeof strategyDataCheckpoints.$inferSelect;
type MemberRow = typeof strategyDataCheckpointMembers.$inferSelect;
type SessionRow = typeof strategyEvaluationSessions.$inferSelect;
type DayRow = typeof strategyEvaluationDays.$inferSelect;

const toCheckpoint = (row: CheckpointRow): StrategyDataCheckpoint => ({
  id: row.id,
  coverage: row.coverage as StrategyDataCheckpoint['coverage'],
  dataAsOf: row.dataAsOf,
  status: row.status,
  vintageStatus: row.vintageStatus ?? 'not-applicable',
  universeSyncId: row.universeSyncId,
  requestedCount: row.requestedCount,
  availableCount: row.availableCount,
  failedCount: row.failedCount,
  memberChecksum: row.memberChecksum,
  dataChecksum: row.dataChecksum,
  providerStatuses: [...row.providerStatuses],
  startedAt: row.startedAt,
  ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
});

const toMember = (row: MemberRow): StrategyDataCheckpointMember => ({
  checkpointId: row.checkpointId,
  stockId: row.stockId,
  status: row.status,
  ...(row.latestBarDate === null ? {} : { latestBarDate: row.latestBarDate }),
  barCount: row.barCount,
  ...(row.provider === null ? {} : { provider: row.provider }),
  ...(row.errorKind === null ? {} : { errorKind: row.errorKind }),
});

const toSession = (row: SessionRow): StrategyEvaluationSession => ({
  id: row.id,
  strategyId: row.strategyId,
  strategyVersionId: row.strategyVersionId,
  from: row.from,
  to: row.to,
  status: row.status,
  definitionHash: row.definitionHash,
  createdAt: row.createdAt,
  ...(row.stockIds === null || row.stockIds === undefined ? {} : { stockIds: [...row.stockIds] }),
  ...(row.stockIdChecksum === null ? {} : { stockIdChecksum: row.stockIdChecksum }),
  ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
  ...(row.error === null ? {} : { error: row.error }),
});

const toDay = (row: DayRow): StrategyEvaluationDay => ({
  sessionId: row.sessionId,
  dataAsOf: row.dataAsOf,
  ...(row.runId === null ? {} : { runId: row.runId }),
  ...(row.universeSyncId === null ? {} : { universeSyncId: row.universeSyncId }),
  ...(row.dataCheckpointId === null ? {} : { dataCheckpointId: row.dataCheckpointId }),
  ...(row.revisionCutoff === null ? {} : { revisionCutoff: row.revisionCutoff }),
  status: row.status,
  ...(row.error === null ? {} : { error: row.error }),
});

export class DrizzleStrategyDataCheckpointRepository implements StrategyDataCheckpointRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async saveStarted(checkpoint: StrategyDataCheckpoint): Promise<void> {
    const parsed = StrategyDataCheckpointSchema.parse(checkpoint);
    if (parsed.status !== 'running')
      throw new InvariantError('saveStarted checkpoint 只接受 running');
    this.db
      .insert(strategyDataCheckpoints)
      .values({ ...parsed, coverage: parsed.coverage, finishedAt: null })
      .run();
  }

  async commit(input: {
    readonly checkpoint: StrategyDataCheckpoint;
    readonly members: readonly StrategyDataCheckpointMember[];
  }): Promise<void> {
    const checkpoint = StrategyDataCheckpointSchema.parse(input.checkpoint);
    const members = input.members.map((member) =>
      StrategyDataCheckpointMemberSchema.parse({ ...member, checkpointId: checkpoint.id }),
    );
    this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(strategyDataCheckpoints)
        .where(eq(strategyDataCheckpoints.id, checkpoint.id))
        .get();
      if (existing === undefined) {
        throw new InvariantError(`checkpoint 未先 saveStarted: ${checkpoint.id}`);
      }
      if (existing !== undefined && existing.status !== 'running') {
        throw new InvariantError(`checkpoint 不能重复提交: ${checkpoint.id}`);
      }
      tx.update(strategyDataCheckpoints)
        .set({
          coverage: checkpoint.coverage,
          dataAsOf: checkpoint.dataAsOf,
          status: checkpoint.status,
          vintageStatus: checkpoint.vintageStatus,
          universeSyncId: checkpoint.universeSyncId,
          requestedCount: checkpoint.requestedCount,
          availableCount: checkpoint.availableCount,
          failedCount: checkpoint.failedCount,
          memberChecksum: checkpoint.memberChecksum,
          dataChecksum: checkpoint.dataChecksum,
          providerStatuses: [...checkpoint.providerStatuses],
          startedAt: checkpoint.startedAt,
          finishedAt: checkpoint.finishedAt ?? null,
        })
        .where(eq(strategyDataCheckpoints.id, checkpoint.id))
        .run();
      tx.delete(strategyDataCheckpointMembers)
        .where(eq(strategyDataCheckpointMembers.checkpointId, checkpoint.id))
        .run();
      if (members.length > 0) {
        tx.insert(strategyDataCheckpointMembers)
          .values(
            members.map((member) => ({
              checkpointId: member.checkpointId,
              stockId: member.stockId,
              status: member.status,
              latestBarDate: member.latestBarDate ?? null,
              barCount: member.barCount,
              provider: member.provider ?? null,
              errorKind: member.errorKind ?? null,
            })),
          )
          .run();
      }
    });
  }

  async findById(id: string): Promise<StrategyDataCheckpoint | null> {
    const row = this.db
      .select()
      .from(strategyDataCheckpoints)
      .where(eq(strategyDataCheckpoints.id, id))
      .get();
    return row === undefined ? null : toCheckpoint(row);
  }

  async listMembers(id: string): Promise<readonly StrategyDataCheckpointMember[]> {
    return this.db
      .select()
      .from(strategyDataCheckpointMembers)
      .where(eq(strategyDataCheckpointMembers.checkpointId, id))
      .orderBy(asc(strategyDataCheckpointMembers.stockId))
      .all()
      .map(toMember);
  }

  async latestUsableAtOrBefore(input: {
    readonly coverage: StrategyDataCheckpoint['coverage'];
    readonly asOf: Date;
    readonly universeSyncId: string;
  }): Promise<StrategyDataCheckpoint | null> {
    const row = this.db
      .select()
      .from(strategyDataCheckpoints)
      .where(
        and(
          eq(strategyDataCheckpoints.coverage, input.coverage),
          eq(strategyDataCheckpoints.universeSyncId, input.universeSyncId),
          lte(strategyDataCheckpoints.dataAsOf, input.asOf),
          or(
            eq(strategyDataCheckpoints.status, 'complete'),
            eq(strategyDataCheckpoints.status, 'partial'),
          ),
        ),
      )
      .orderBy(desc(strategyDataCheckpoints.dataAsOf), desc(strategyDataCheckpoints.id))
      .limit(1)
      .get();
    return row === undefined ? null : toCheckpoint(row);
  }
}

export class DrizzleStrategyEvaluationRepository implements StrategyEvaluationRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async saveSession(session: StrategyEvaluationSession): Promise<void> {
    const parsed = StrategyEvaluationSessionSchema.parse(session);
    this.db
      .insert(strategyEvaluationSessions)
      .values({
        ...parsed,
        from: parsed.from,
        to: parsed.to,
        finishedAt: parsed.finishedAt ?? null,
        error: parsed.error ?? null,
      })
      .onConflictDoUpdate({
        target: strategyEvaluationSessions.id,
        set: {
          status: parsed.status,
          finishedAt: parsed.finishedAt ?? null,
          error: parsed.error ?? null,
        },
      })
      .run();
  }

  async findSessionById(id: string): Promise<StrategyEvaluationSession | null> {
    const row = this.db
      .select()
      .from(strategyEvaluationSessions)
      .where(eq(strategyEvaluationSessions.id, id))
      .get();
    return row === undefined ? null : toSession(row);
  }

  async saveDay(day: StrategyEvaluationDay): Promise<void> {
    const parsed = StrategyEvaluationDaySchema.parse(day);
    this.db
      .insert(strategyEvaluationDays)
      .values({
        ...parsed,
        runId: parsed.runId ?? null,
        universeSyncId: parsed.universeSyncId ?? null,
        dataCheckpointId: parsed.dataCheckpointId ?? null,
        revisionCutoff: parsed.revisionCutoff ?? null,
        error: parsed.error ?? null,
      })
      .onConflictDoUpdate({
        target: [strategyEvaluationDays.sessionId, strategyEvaluationDays.dataAsOf],
        set: {
          runId: parsed.runId ?? null,
          universeSyncId: parsed.universeSyncId ?? null,
          dataCheckpointId: parsed.dataCheckpointId ?? null,
          revisionCutoff: parsed.revisionCutoff ?? null,
          status: parsed.status,
          error: parsed.error ?? null,
        },
      })
      .run();
  }

  async findDay(input: {
    readonly sessionId: string;
    readonly dataAsOf: Date;
  }): Promise<StrategyEvaluationDay | null> {
    const row = this.db
      .select()
      .from(strategyEvaluationDays)
      .where(
        and(
          eq(strategyEvaluationDays.sessionId, input.sessionId),
          eq(strategyEvaluationDays.dataAsOf, input.dataAsOf),
        ),
      )
      .get();
    return row === undefined ? null : toDay(row);
  }

  async listDays(sessionId: string): Promise<readonly StrategyEvaluationDay[]> {
    return this.db
      .select()
      .from(strategyEvaluationDays)
      .where(eq(strategyEvaluationDays.sessionId, sessionId))
      .orderBy(asc(strategyEvaluationDays.dataAsOf))
      .all()
      .map(toDay);
  }
}
