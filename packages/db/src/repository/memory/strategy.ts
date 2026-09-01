import {
  assertStrategyInvariants,
  assertStrategyRunBundleInvariants,
  assertStrategyRunInvariants,
  assertStrategyVersionInvariants,
  InvariantError,
  normalizeLegacyStrategyRun,
  type Strategy,
  type StrategyLeaseToken,
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

  async remove(strategyId: string): Promise<void> {
    for (const [id, version] of this.versions) {
      if (version.strategyId === strategyId) this.versions.delete(id);
    }
    this.strategies.delete(strategyId);
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
  private readonly runLeases = new Map<
    string,
    {
      readonly owner: string;
      readonly until: Date;
      readonly fence: number;
      readonly heartbeatAt: Date;
    }
  >();

  constructor(private readonly strategyRepository: InMemoryStrategyRepository) {}

  async acquireRunLeaseToken(input: {
    readonly strategyId: string;
    readonly strategyVersionId: string;
    readonly owner: string;
    readonly runId?: string;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<StrategyLeaseToken | null> {
    const key = `${input.strategyId}\0${input.strategyVersionId}`;
    const existing = this.runLeases.get(key);
    if (existing !== undefined && existing.until.getTime() > input.now.getTime()) return null;
    const fence = (existing?.fence ?? 0) + 1;
    this.runLeases.set(key, {
      owner: input.owner,
      until: input.leaseUntil,
      fence,
      heartbeatAt: input.now,
    });
    return {
      strategyId: input.strategyId,
      strategyVersionId: input.strategyVersionId,
      owner: input.owner,
      fence,
      leaseUntil: input.leaseUntil,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    };
  }

  async renewRunLease(input: {
    readonly token: StrategyLeaseToken;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<boolean> {
    const key = `${input.token.strategyId}\0${input.token.strategyVersionId}`;
    const existing = this.runLeases.get(key);
    if (
      existing === undefined ||
      existing.owner !== input.token.owner ||
      existing.fence !== input.token.fence ||
      existing.until.getTime() <= input.now.getTime()
    ) {
      return false;
    }
    this.runLeases.set(key, {
      ...existing,
      until: input.leaseUntil,
      heartbeatAt: input.now,
    });
    return true;
  }

  async releaseRunLease(input: {
    readonly strategyId: string;
    readonly strategyVersionId: string;
    readonly owner: string;
    readonly fence?: number;
  }): Promise<void> {
    const key = `${input.strategyId}\0${input.strategyVersionId}`;
    const lease = this.runLeases.get(key);
    if (
      lease?.owner === input.owner &&
      (input.fence === undefined || input.fence === lease.fence)
    ) {
      this.runLeases.delete(key);
    }
  }

  async commitRunWithFence(input: {
    readonly token: StrategyLeaseToken;
    readonly now: Date;
    readonly bundle: StrategyRunBundle;
  }): Promise<'committed' | 'lease-lost'> {
    const key = `${input.token.strategyId}\0${input.token.strategyVersionId}`;
    const lease = this.runLeases.get(key);
    if (
      lease === undefined ||
      lease.owner !== input.token.owner ||
      lease.fence !== input.token.fence ||
      lease.until.getTime() <= input.now.getTime() ||
      (input.token.runId !== undefined && input.token.runId !== input.bundle.run.id)
    ) {
      return 'lease-lost';
    }
    const existingRun = this.runs.get(input.bundle.run.id);
    if (
      existingRun === undefined ||
      existingRun.status !== 'running' ||
      input.bundle.run.status === 'running' ||
      existingRun.strategyId !== input.bundle.run.strategyId ||
      existingRun.strategyVersionId !== input.bundle.run.strategyVersionId ||
      existingRun.startedAt.getTime() !== input.bundle.run.startedAt.getTime() ||
      input.bundle.run.strategyId !== input.token.strategyId ||
      input.bundle.run.strategyVersionId !== input.token.strategyVersionId
    ) {
      return 'lease-lost';
    }
    await this.commitRun(input.bundle);
    return 'committed';
  }

  async removeByStrategyId(strategyId: string): Promise<void> {
    const runIds = new Set(
      [...this.runs.values()].filter((run) => run.strategyId === strategyId).map((run) => run.id),
    );
    for (const [id, run] of this.runs) {
      if (run.strategyId === strategyId) this.runs.delete(id);
    }
    for (const [id, result] of this.results) {
      if (runIds.has(result.runId)) this.results.delete(id);
    }
    for (const [id, signal] of this.signals) {
      if (signal.strategyId === strategyId) this.signals.delete(id);
    }
    for (const key of this.runLeases.keys()) {
      if (key.startsWith(`${strategyId}\0`)) this.runLeases.delete(key);
    }
  }

  async findRunById(id: string): Promise<StrategyRun | null> {
    const run = this.runs.get(id);
    return run === undefined ? null : normalizeLegacyStrategyRun(run);
  }

  async listRuns(
    filter: {
      readonly strategyId?: string;
      readonly status?: StrategyRun['status'];
      readonly scope?: StrategyRun['scope'];
      readonly publication?: NonNullable<StrategyRun['publication']>['status'];
      readonly since?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<readonly StrategyRun[]> {
    const sorted = [...this.runs.values()]
      .map(normalizeLegacyStrategyRun)
      .filter(
        (run) =>
          (filter.strategyId === undefined || run.strategyId === filter.strategyId) &&
          (filter.status === undefined || run.status === filter.status) &&
          (filter.scope === undefined || run.scope === filter.scope) &&
          (filter.publication === undefined || run.publication?.status === filter.publication) &&
          (filter.since === undefined || run.startedAt >= filter.since),
      )
      .sort(
        (left, right) =>
          right.startedAt.getTime() - left.startedAt.getTime() || right.id.localeCompare(left.id),
      );
    return filter.limit === undefined ? sorted : sorted.slice(0, filter.limit);
  }

  async findLatestPublishedRun(strategyId: string): Promise<StrategyRun | null> {
    return (
      (await this.listRuns({ strategyId, scope: 'operational', publication: 'published' })).find(
        (run) => run.status === 'complete' || run.status === 'partial',
      ) ?? null
    );
  }

  async findPreviousPublishedRun(input: {
    readonly strategyId: string;
    readonly beforeStartedAt: Date;
    readonly beforeRunId: string;
  }): Promise<StrategyRun | null> {
    return (
      (
        await this.listRuns({
          strategyId: input.strategyId,
          scope: 'operational',
          publication: 'published',
        })
      ).find(
        (run) =>
          (run.status === 'complete' || run.status === 'partial') &&
          (run.startedAt.getTime() < input.beforeStartedAt.getTime() ||
            (run.startedAt.getTime() === input.beforeStartedAt.getTime() &&
              run.id.localeCompare(input.beforeRunId) < 0)),
      ) ?? null
    );
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

  async listResultsByRuns(runIds: readonly string[]): Promise<readonly StrategyResult[]> {
    if (runIds.length === 0) return [];
    const runIdSet = new Set(runIds);
    return [...this.results.values()]
      .filter((result) => runIdSet.has(result.runId))
      .sort(
        (left, right) =>
          left.runId.localeCompare(right.runId) ||
          (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER) ||
          left.stockId.localeCompare(right.stockId),
      );
  }

  async saveStartedRun(run: StrategyRun): Promise<void> {
    assertStrategyRunInvariants(run);
    if (run.status !== 'running') throw new InvariantError('saveStartedRun 只接受 running');
    if (!this.strategyRepository.isRunnableVersion(run.strategyId, run.strategyVersionId)) {
      throw new InvariantError('StrategyRun 必须绑定 active Strategy 的 published valid version');
    }
    if (this.runs.has(run.id)) throw new InvariantError(`StrategyRun.runId 已存在: ${run.id}`);
    this.runs.set(run.id, run);
  }

  async commitRun(bundle: StrategyRunBundle): Promise<void> {
    assertStrategyRunBundleInvariants(bundle);
    const existingRun = this.runs.get(bundle.run.id);
    if (existingRun !== undefined) {
      if (
        existingRun.status !== 'running' ||
        bundle.run.status === 'running' ||
        existingRun.strategyId !== bundle.run.strategyId ||
        existingRun.strategyVersionId !== bundle.run.strategyVersionId ||
        existingRun.startedAt.getTime() !== bundle.run.startedAt.getTime()
      ) {
        throw new InvariantError(`StrategyRun.runId 已存在: ${bundle.run.id}`);
      }
    } else if (
      !this.strategyRepository.isRunnableVersion(
        bundle.run.strategyId,
        bundle.run.strategyVersionId,
      )
    ) {
      throw new InvariantError('StrategyRun 必须绑定 active Strategy 的 published valid version');
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

  async signalsByRuns(runIds: readonly string[]): Promise<readonly StrategySignal[]> {
    if (runIds.length === 0) return [];
    const runIdSet = new Set(runIds);
    return this.sortedSignals((signal) => runIdSet.has(signal.runId));
  }

  async signalsByIds(signalIds: readonly string[]): Promise<readonly StrategySignal[]> {
    if (signalIds.length === 0) return [];
    const signalIdSet = new Set(signalIds);
    return this.sortedSignals((signal) => signalIdSet.has(signal.id));
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
