import {
  assertStrategyInvariants,
  assertStrategyRunBundleInvariants,
  assertStrategyVersionInvariants,
  InvariantError,
  type Strategy,
  type StrategyRepository,
  type StrategyResult,
  type StrategyRun,
  type StrategyRunBundle,
  type StrategyRunRepository,
  type StrategySignal,
  type StrategyVersion,
} from '@luoome/core';

export class InMemoryStrategyRepository implements StrategyRepository {
  private readonly strategies = new Map<string, Strategy>();
  private readonly versions = new Map<string, StrategyVersion>();

  async create(strategy: Strategy): Promise<void> {
    assertStrategyInvariants(strategy);
    if (this.strategies.has(strategy.id)) {
      throw new InvariantError(`Strategy 已存在: ${strategy.id}`);
    }
    this.strategies.set(strategy.id, strategy);
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

  async createVersion(version: StrategyVersion): Promise<void> {
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
    if (existing !== undefined) throw new InvariantError(`StrategyVersion 已存在: ${version.id}`);
    const maxVersion = Math.max(
      0,
      ...[...this.versions.values()]
        .filter((candidate) => candidate.strategyId === version.strategyId)
        .map((candidate) => candidate.version),
    );
    if (existing === undefined && version.version <= maxVersion) {
      throw new InvariantError('新 StrategyVersion.version 必须严格递增');
    }
    this.versions.set(version.id, version);
  }

  async setVersionValidation(
    versionId: string,
    validation: { readonly status: 'valid' | 'invalid'; readonly errors: readonly string[] },
  ): Promise<void> {
    const version = this.versions.get(versionId);
    if (version === undefined) throw new InvariantError(`StrategyVersion 不存在: ${versionId}`);
    const strategy = this.strategies.get(version.strategyId);
    if (strategy?.owner !== 'user') throw new InvariantError('builtin StrategyVersion 不可修改');
    if (version.publishedAt !== undefined) {
      throw new InvariantError('published StrategyVersion 不可重新校验修改');
    }
    this.versions.set(versionId, {
      ...version,
      validationStatus: validation.status,
      validationErrors: [...validation.errors],
    });
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
      strategy.owner !== 'user' ||
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

  async pause(strategyId: string, at: Date): Promise<void> {
    const strategy = this.strategies.get(strategyId);
    if (strategy === undefined) throw new InvariantError(`Strategy 不存在: ${strategyId}`);
    if (strategy.owner !== 'user' || strategy.status !== 'active') {
      throw new InvariantError('只有 active 的用户 Strategy 可暂停');
    }
    this.strategies.set(strategyId, { ...strategy, status: 'paused', updatedAt: at });
  }

  async resume(strategyId: string, at: Date): Promise<void> {
    const strategy = this.strategies.get(strategyId);
    if (strategy === undefined) throw new InvariantError(`Strategy 不存在: ${strategyId}`);
    const version =
      strategy.currentVersionId === undefined
        ? undefined
        : this.versions.get(strategy.currentVersionId);
    if (
      strategy.owner !== 'user' ||
      strategy.status !== 'paused' ||
      version?.validationStatus !== 'valid' ||
      version.publishedAt === undefined
    ) {
      throw new InvariantError('恢复需要 paused 用户 Strategy 及已发布 valid currentVersion');
    }
    this.strategies.set(strategyId, { ...strategy, status: 'active', updatedAt: at });
  }
}

export class InMemoryStrategyRunRepository implements StrategyRunRepository {
  private readonly runs = new Map<string, StrategyRun>();
  private readonly results = new Map<string, StrategyResult>();
  private readonly signals = new Map<string, StrategySignal>();
  private readonly runLeases = new Map<string, { readonly owner: string; readonly until: Date }>();

  constructor(private readonly strategyRepository: InMemoryStrategyRepository) {}

  async acquireRunLease(input: {
    readonly strategyId: string;
    readonly strategyVersionId: string;
    readonly owner: string;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<boolean> {
    const key = `${input.strategyId}\0${input.strategyVersionId}`;
    const existing = this.runLeases.get(key);
    if (existing !== undefined && existing.until.getTime() > input.now.getTime()) return false;
    this.runLeases.set(key, { owner: input.owner, until: input.leaseUntil });
    return true;
  }

  async releaseRunLease(input: {
    readonly strategyId: string;
    readonly strategyVersionId: string;
    readonly owner: string;
  }): Promise<void> {
    const key = `${input.strategyId}\0${input.strategyVersionId}`;
    if (this.runLeases.get(key)?.owner === input.owner) this.runLeases.delete(key);
  }

  async findRunById(id: string): Promise<StrategyRun | null> {
    return this.runs.get(id) ?? null;
  }

  async listRuns(
    filter: {
      readonly strategyId?: string;
      readonly status?: StrategyRun['status'];
      readonly since?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<readonly StrategyRun[]> {
    const sorted = [...this.runs.values()]
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
    return filter.limit === undefined ? sorted : sorted.slice(0, filter.limit);
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

  async commitRun(bundle: StrategyRunBundle): Promise<void> {
    assertStrategyRunBundleInvariants(bundle);
    if (
      !this.strategyRepository.isRunnableVersion(
        bundle.run.strategyId,
        bundle.run.strategyVersionId,
      )
    ) {
      throw new InvariantError('StrategyRun 必须绑定 active Strategy 的 published valid version');
    }
    if (this.runs.has(bundle.run.id)) {
      throw new InvariantError(`StrategyRun.runId 已存在: ${bundle.run.id}`);
    }
    for (const signal of bundle.signals) {
      const identity = this.signalIdentity(signal);
      if (
        this.signals.has(identity) ||
        [...this.signals.values()].some((existing) => existing.id === signal.id)
      ) {
        throw new InvariantError(`StrategySignal identity 已存在: ${signal.id}`);
      }
    }
    this.runs.set(bundle.run.id, bundle.run);
    for (const result of bundle.results) {
      this.results.set(`${result.runId}\0${result.stockId}`, result);
    }
    for (const signal of bundle.signals) {
      this.signals.set(this.signalIdentity(signal), signal);
    }
  }

  private signalIdentity(signal: StrategySignal): string {
    return `${signal.runId}\0${signal.ruleId}\0${signal.stockId}\0${signal.ts.toISOString()}`;
  }

  async signalsByStrategy(strategyId: string, since?: Date): Promise<readonly StrategySignal[]> {
    return this.sortedSignals(
      (signal) =>
        signal.strategyId === strategyId &&
        (since === undefined || signal.ts.getTime() >= since.getTime()),
    );
  }

  async signalsByRun(runId: string): Promise<readonly StrategySignal[]> {
    return this.sortedSignals((signal) => signal.runId === runId);
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
