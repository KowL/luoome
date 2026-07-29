import {
  assertStrategyInvariants,
  assertStrategyRunInvariants,
  assertStrategyVersionInvariants,
  InvariantError,
  type Strategy,
  type StrategyRepository,
  type StrategyResult,
  StrategyResultSchema,
  type StrategyRun,
  type StrategyRunRepository,
  type StrategySignal,
  StrategySignalSchema,
  type StrategyVersion,
} from '@luoome/core';

export class InMemoryStrategyRepository implements StrategyRepository {
  private readonly strategies = new Map<string, Strategy>();
  private readonly versions = new Map<string, StrategyVersion>();

  async save(strategy: Strategy): Promise<void> {
    assertStrategyInvariants(strategy);
    const existing = this.strategies.get(strategy.id);
    this.strategies.set(
      strategy.id,
      existing === undefined ? strategy : { ...strategy, owner: existing.owner },
    );
  }

  async findById(id: string): Promise<Strategy | null> {
    return this.strategies.get(id) ?? null;
  }

  async list(
    filter: { readonly status?: Strategy['status']; readonly owner?: Strategy['owner'] } = {},
  ): Promise<readonly Strategy[]> {
    return [...this.strategies.values()]
      .filter(
        (strategy) =>
          (filter.status === undefined || strategy.status === filter.status) &&
          (filter.owner === undefined || strategy.owner === filter.owner),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async saveVersion(version: StrategyVersion): Promise<void> {
    const strategy = this.strategies.get(version.strategyId);
    if (strategy === undefined) throw new InvariantError(`Strategy 不存在: ${version.strategyId}`);
    assertStrategyVersionInvariants(version, strategy.owner);
    if (version.parentVersionId !== undefined) {
      const parent = this.versions.get(version.parentVersionId);
      if (parent === undefined || parent.strategyId !== version.strategyId) {
        throw new InvariantError('parentVersionId 必须指向同一 Strategy');
      }
    }
    const sameNumber = [...this.versions.values()].find(
      (candidate) =>
        candidate.strategyId === version.strategyId &&
        candidate.version === version.version &&
        candidate.id !== version.id,
    );
    if (sameNumber !== undefined) throw new InvariantError('(strategyId, version) 必须唯一');
    const existing = this.versions.get(version.id);
    const maxVersion = Math.max(
      0,
      ...[...this.versions.values()]
        .filter((candidate) => candidate.strategyId === version.strategyId)
        .map((candidate) => candidate.version),
    );
    if (existing === undefined && version.version <= maxVersion) {
      throw new InvariantError('新 StrategyVersion.version 必须严格递增');
    }
    if (existing?.publishedAt !== undefined && existing.definitionHash !== version.definitionHash) {
      throw new InvariantError('published StrategyVersion 的 definition 不可修改');
    }
    this.versions.set(version.id, version);
  }

  isRunnableVersion(strategyId: string, versionId: string): boolean {
    const strategy = this.strategies.get(strategyId);
    const version = this.versions.get(versionId);
    return (
      strategy !== undefined &&
      strategy.status === 'active' &&
      version?.strategyId === strategyId &&
      version.validationStatus === 'valid' &&
      version.publishedAt !== undefined
    );
  }

  async findVersionById(id: string): Promise<StrategyVersion | null> {
    return this.versions.get(id) ?? null;
  }

  async listVersions(strategyId: string): Promise<readonly StrategyVersion[]> {
    return [...this.versions.values()]
      .filter((version) => version.strategyId === strategyId)
      .sort((left, right) => left.version - right.version);
  }

  async activateVersion(strategyId: string, versionId: string, at: Date): Promise<void> {
    const strategy = this.strategies.get(strategyId);
    const version = this.versions.get(versionId);
    if (strategy === undefined) throw new InvariantError(`Strategy 不存在: ${strategyId}`);
    if (
      version === undefined ||
      version.strategyId !== strategyId ||
      version.validationStatus !== 'valid' ||
      version.publishedAt === undefined
    ) {
      throw new InvariantError('只能激活同一 Strategy 下已发布且 valid 的 version');
    }
    this.strategies.set(strategyId, {
      ...strategy,
      currentVersionId: versionId,
      status: 'active',
      updatedAt: at,
    });
  }

  async publishVersion(strategyId: string, versionId: string, at: Date): Promise<void> {
    const strategy = this.strategies.get(strategyId);
    const version = this.versions.get(versionId);
    if (strategy === undefined) throw new InvariantError(`Strategy 不存在: ${strategyId}`);
    if (
      version === undefined ||
      version.strategyId !== strategyId ||
      version.validationStatus !== 'valid'
    ) {
      throw new InvariantError('只能发布同一 Strategy 下 valid 的 version');
    }
    this.versions.set(versionId, { ...version, publishedAt: version.publishedAt ?? at });
    this.strategies.set(strategyId, {
      ...strategy,
      currentVersionId: versionId,
      status: 'active',
      updatedAt: at,
    });
  }
}

export class InMemoryStrategyRunRepository implements StrategyRunRepository {
  private readonly runs = new Map<string, StrategyRun>();
  private readonly results = new Map<string, StrategyResult>();
  private readonly signals = new Map<string, StrategySignal>();

  constructor(private readonly strategyRepository: InMemoryStrategyRepository) {}

  async saveRun(run: StrategyRun): Promise<void> {
    assertStrategyRunInvariants(run);
    if (!this.strategyRepository.isRunnableVersion(run.strategyId, run.strategyVersionId)) {
      throw new InvariantError('StrategyRun 必须绑定 active Strategy 的 published valid version');
    }
    this.runs.set(run.id, run);
  }

  async findRunById(id: string): Promise<StrategyRun | null> {
    return this.runs.get(id) ?? null;
  }

  async listRuns(
    filter: {
      readonly strategyId?: string;
      readonly status?: StrategyRun['status'];
      readonly since?: Date;
    } = {},
  ): Promise<readonly StrategyRun[]> {
    return [...this.runs.values()]
      .filter(
        (run) =>
          (filter.strategyId === undefined || run.strategyId === filter.strategyId) &&
          (filter.status === undefined || run.status === filter.status) &&
          (filter.since === undefined || run.startedAt >= filter.since),
      )
      .sort(
        (left, right) =>
          right.startedAt.getTime() - left.startedAt.getTime() || right.id.localeCompare(left.id),
      );
  }

  async saveResults(results: readonly StrategyResult[]): Promise<void> {
    for (const result of results) {
      StrategyResultSchema.parse(result);
      if (!this.runs.has(result.runId))
        throw new InvariantError(`StrategyRun 不存在: ${result.runId}`);
      this.results.set(`${result.runId}\0${result.stockId}`, result);
    }
  }

  async listResults(runId: string): Promise<readonly StrategyResult[]> {
    return [...this.results.values()]
      .filter((result) => result.runId === runId)
      .sort(
        (left, right) =>
          (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER) ||
          left.stockId.localeCompare(right.stockId),
      );
  }

  async saveSignals(signals: readonly StrategySignal[]): Promise<void> {
    for (const signal of signals) {
      StrategySignalSchema.parse(signal);
      if (!this.runs.has(signal.runId))
        throw new InvariantError(`StrategyRun 不存在: ${signal.runId}`);
      const identity = `${signal.strategyVersionId}\0${signal.ruleId}\0${signal.stockId}\0${signal.ts.getTime()}`;
      if (!this.signals.has(identity)) {
        this.signals.set(identity, signal);
      }
    }
  }

  async commitRun(bundle: {
    readonly run: StrategyRun;
    readonly results: readonly StrategyResult[];
    readonly signals: readonly StrategySignal[];
  }): Promise<void> {
    assertStrategyRunInvariants(bundle.run);
    if (bundle.run.status === 'running') {
      throw new InvariantError('commitRun 只接受终态 StrategyRun');
    }
    if (
      !this.strategyRepository.isRunnableVersion(
        bundle.run.strategyId,
        bundle.run.strategyVersionId,
      )
    ) {
      throw new InvariantError('StrategyRun 必须绑定 active Strategy 的 published valid version');
    }
    for (const result of bundle.results) {
      StrategyResultSchema.parse(result);
      if (result.runId !== bundle.run.id) throw new InvariantError('StrategyResult.runId 不匹配');
    }
    for (const signal of bundle.signals) {
      StrategySignalSchema.parse(signal);
      if (
        signal.runId !== bundle.run.id ||
        signal.strategyId !== bundle.run.strategyId ||
        signal.strategyVersionId !== bundle.run.strategyVersionId
      ) {
        throw new InvariantError('StrategySignal 引用与 run 不匹配');
      }
    }
    this.runs.set(bundle.run.id, bundle.run);
    for (const result of bundle.results) {
      this.results.set(`${result.runId}\0${result.stockId}`, result);
    }
    for (const signal of bundle.signals) {
      const identity = `${signal.strategyVersionId}\0${signal.ruleId}\0${signal.stockId}\0${signal.ts.getTime()}`;
      if (!this.signals.has(identity)) this.signals.set(identity, signal);
    }
  }

  async signalsByStrategy(strategyId: string, since?: Date): Promise<readonly StrategySignal[]> {
    return this.sortedSignals(
      (signal) =>
        signal.strategyId === strategyId &&
        (since === undefined || signal.ts.getTime() >= since.getTime()),
    );
  }

  async signalsByStock(stockId: string, since?: Date): Promise<readonly StrategySignal[]> {
    return this.sortedSignals(
      (signal) =>
        signal.stockId === stockId &&
        (since === undefined || signal.ts.getTime() >= since.getTime()),
    );
  }

  private sortedSignals(predicate: (signal: StrategySignal) => boolean): readonly StrategySignal[] {
    return [...this.signals.values()]
      .filter(predicate)
      .sort(
        (left, right) => right.ts.getTime() - left.ts.getTime() || right.id.localeCompare(left.id),
      );
  }
}
