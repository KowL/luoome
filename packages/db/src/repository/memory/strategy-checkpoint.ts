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

export class InMemoryStrategyDataCheckpointRepository implements StrategyDataCheckpointRepository {
  private readonly checkpoints = new Map<string, StrategyDataCheckpoint>();
  private readonly members = new Map<string, Map<string, StrategyDataCheckpointMember>>();

  async saveStarted(checkpoint: StrategyDataCheckpoint): Promise<void> {
    const parsed = StrategyDataCheckpointSchema.parse(checkpoint);
    if (parsed.status !== 'running') {
      throw new InvariantError('saveStarted checkpoint 只接受 running');
    }
    if (this.checkpoints.has(parsed.id))
      throw new InvariantError(`checkpoint 已存在: ${parsed.id}`);
    this.checkpoints.set(parsed.id, parsed);
  }

  async commit(input: {
    readonly checkpoint: StrategyDataCheckpoint;
    readonly members: readonly StrategyDataCheckpointMember[];
  }): Promise<void> {
    const checkpoint = StrategyDataCheckpointSchema.parse(input.checkpoint);
    const existing = this.checkpoints.get(checkpoint.id);
    if (existing === undefined) {
      throw new InvariantError(`checkpoint 未先 saveStarted: ${checkpoint.id}`);
    }
    if (existing !== undefined && existing.status !== 'running') {
      throw new InvariantError(`checkpoint 不能重复提交: ${checkpoint.id}`);
    }
    const rows = input.members.map((member) =>
      StrategyDataCheckpointMemberSchema.parse({ ...member, checkpointId: checkpoint.id }),
    );
    const seen = new Set<string>();
    for (const member of rows) {
      if (seen.has(member.stockId))
        throw new InvariantError(`checkpoint member 重复: ${member.stockId}`);
      seen.add(member.stockId);
    }
    this.checkpoints.set(checkpoint.id, checkpoint);
    this.members.set(checkpoint.id, new Map(rows.map((member) => [member.stockId, member])));
  }

  async findById(id: string): Promise<StrategyDataCheckpoint | null> {
    return this.checkpoints.get(id) ?? null;
  }

  async listMembers(id: string): Promise<readonly StrategyDataCheckpointMember[]> {
    return [...(this.members.get(id)?.values() ?? [])].sort((left, right) =>
      left.stockId.localeCompare(right.stockId),
    );
  }

  async latestUsableAtOrBefore(input: {
    readonly coverage: StrategyDataCheckpoint['coverage'];
    readonly asOf: Date;
    readonly universeSyncId: string;
  }): Promise<StrategyDataCheckpoint | null> {
    return (
      [...this.checkpoints.values()]
        .filter(
          (checkpoint) =>
            checkpoint.coverage === input.coverage &&
            checkpoint.universeSyncId === input.universeSyncId &&
            (checkpoint.status === 'complete' || checkpoint.status === 'partial') &&
            checkpoint.dataAsOf.getTime() <= input.asOf.getTime(),
        )
        .sort(
          (left, right) =>
            right.dataAsOf.getTime() - left.dataAsOf.getTime() || right.id.localeCompare(left.id),
        )[0] ?? null
    );
  }
}

export class InMemoryStrategyEvaluationRepository implements StrategyEvaluationRepository {
  private readonly sessions = new Map<string, StrategyEvaluationSession>();
  private readonly days = new Map<string, StrategyEvaluationDay>();

  async saveSession(session: StrategyEvaluationSession): Promise<void> {
    const parsed = StrategyEvaluationSessionSchema.parse(session);
    this.sessions.set(parsed.id, parsed);
  }

  async findSessionById(id: string): Promise<StrategyEvaluationSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async saveDay(day: StrategyEvaluationDay): Promise<void> {
    const parsed = StrategyEvaluationDaySchema.parse(day);
    const key = `${parsed.sessionId}\0${parsed.dataAsOf.toISOString()}`;
    this.days.set(key, parsed);
  }

  async findDay(input: {
    readonly sessionId: string;
    readonly dataAsOf: Date;
  }): Promise<StrategyEvaluationDay | null> {
    return this.days.get(`${input.sessionId}\0${input.dataAsOf.toISOString()}`) ?? null;
  }

  async listDays(sessionId: string): Promise<readonly StrategyEvaluationDay[]> {
    return [...this.days.values()]
      .filter((day) => day.sessionId === sessionId)
      .sort((left, right) => left.dataAsOf.getTime() - right.dataAsOf.getTime());
  }
}
