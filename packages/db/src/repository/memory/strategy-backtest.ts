import {
  InvariantError,
  type StrategyBacktestRepository,
  type StrictBacktestMarketFact,
  StrictBacktestMarketFactSchema,
  type StrictBacktestRun,
  StrictBacktestRunSchema,
} from '@luoome/core';

const immutableIdentity = (run: StrictBacktestRun): string =>
  JSON.stringify({
    id: run.id,
    specHash: run.specHash,
    inputFingerprint: run.inputFingerprint,
    evaluator: run.evaluator,
  });

const allowedTransition = (
  from: StrictBacktestRun['status'],
  to: StrictBacktestRun['status'],
): boolean =>
  from === to ||
  (from === 'queued' && (to === 'running' || to === 'complete' || to === 'failed')) ||
  (from === 'running' && (to === 'complete' || to === 'failed'));

export class InMemoryStrategyBacktestRepository implements StrategyBacktestRepository {
  private readonly runs = new Map<string, StrictBacktestRun>();
  private readonly facts = new Map<string, StrictBacktestMarketFact>();

  async saveRun(run: StrictBacktestRun): Promise<void> {
    const parsed = StrictBacktestRunSchema.parse(run);
    const existing = this.runs.get(parsed.id);
    if (existing !== undefined) {
      if (immutableIdentity(existing) !== immutableIdentity(parsed)) {
        throw new InvariantError('strict backtest immutable identity 不能修改');
      }
      if (!allowedTransition(existing.status, parsed.status)) {
        throw new InvariantError(
          `strict backtest 非法状态迁移: ${existing.status}->${parsed.status}`,
        );
      }
    }
    this.runs.set(parsed.id, parsed);
  }

  async findRunById(id: string): Promise<StrictBacktestRun | null> {
    return this.runs.get(id) ?? null;
  }

  async listRuns(input?: {
    readonly strategyId?: string;
    readonly limit?: number;
  }): Promise<readonly StrictBacktestRun[]> {
    return [...this.runs.values()]
      .filter((run) => input?.strategyId === undefined || run.spec.strategyId === input.strategyId)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
      )
      .slice(0, input?.limit ?? 50);
  }

  async saveMarketFacts(facts: readonly StrictBacktestMarketFact[]): Promise<void> {
    for (const fact of facts) {
      const parsed = StrictBacktestMarketFactSchema.parse(fact);
      const key = `${parsed.stockId}\0${parsed.date.toISOString()}\0${parsed.recordedAt.toISOString()}\0${parsed.contentHash}`;
      this.facts.set(key, parsed);
    }
  }

  async listMarketFacts(input: {
    readonly stockIds: readonly string[];
    readonly from: Date;
    readonly to: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly StrictBacktestMarketFact[]> {
    const stockIds = new Set(input.stockIds);
    return [...this.facts.values()]
      .filter(
        (fact) =>
          stockIds.has(fact.stockId) &&
          fact.date >= input.from &&
          fact.date <= input.to &&
          (input.recordedAt === undefined || fact.recordedAt <= input.recordedAt),
      )
      .sort(
        (left, right) =>
          left.date.getTime() - right.date.getTime() ||
          left.stockId.localeCompare(right.stockId) ||
          left.recordedAt.getTime() - right.recordedAt.getTime() ||
          left.contentHash.localeCompare(right.contentHash),
      );
  }
}
