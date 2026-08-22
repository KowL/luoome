import {
  type FundamentalScoreResult,
  type FundamentalScoreRun,
  type FundamentalScoreRunRepository,
  type FundamentalScoreVersion,
  type FundamentalScoreVersionRepository,
  InvariantError,
} from '@luoome/core';

import {
  assertRunForCommit,
  assertRunIdentity,
  assertVersionSaveTransition,
  canonicalJson,
  compareResults,
  copy,
  parseResult,
  parseRun,
  parseVersion,
  resultJson,
  runJson,
} from '../fundamental-score.js';

const sortedResults = (results: readonly FundamentalScoreResult[]): FundamentalScoreResult[] =>
  [...results].sort(compareResults);

const sameResults = (
  left: readonly FundamentalScoreResult[],
  right: readonly FundamentalScoreResult[],
): boolean => {
  const a = sortedResults(left);
  const b = sortedResults(right);
  return (
    a.length === b.length &&
    a.every((result, index) => {
      const other = b[index];
      return other !== undefined && resultJson(result) === resultJson(other);
    })
  );
};

export class InMemoryFundamentalScoreVersionRepository
  implements FundamentalScoreVersionRepository
{
  private readonly versions = new Map<string, FundamentalScoreVersion>();

  async save(version: FundamentalScoreVersion): Promise<void> {
    const parsed = parseVersion(version);
    const existing = this.versions.get(parsed.id);
    if (existing === undefined) {
      const hashOwner = [...this.versions.values()].find(
        (candidate) => candidate.definitionHash === parsed.definitionHash,
      );
      if (hashOwner !== undefined && hashOwner.id !== parsed.id) {
        throw new InvariantError(
          `FundamentalScoreVersion.definitionHash 已被其他 id 使用: ${parsed.definitionHash}`,
        );
      }
      this.versions.set(parsed.id, copy(parsed));
      return;
    }
    assertVersionSaveTransition(existing, parsed);
    if (canonicalJson(existing) === canonicalJson(parsed)) return;
    this.versions.set(parsed.id, copy(parsed));
  }

  async findById(id: string): Promise<FundamentalScoreVersion | null> {
    const version = this.versions.get(id);
    return version === undefined ? null : copy(version);
  }

  async list(
    input: { readonly status?: FundamentalScoreVersion['status'] } = {},
  ): Promise<readonly FundamentalScoreVersion[]> {
    return [...this.versions.values()]
      .filter((version) => input.status === undefined || version.status === input.status)
      .sort((left, right) => left.version - right.version || left.id.localeCompare(right.id))
      .map(copy);
  }
}

export class InMemoryFundamentalScoreRunRepository implements FundamentalScoreRunRepository {
  private readonly runs = new Map<string, FundamentalScoreRun>();
  private readonly results = new Map<string, Map<string, FundamentalScoreResult>>();

  async saveStarted(run: FundamentalScoreRun): Promise<void> {
    const parsed = parseRun(run);
    if (parsed.status !== 'started') {
      throw new InvariantError(`saveStarted 只接受 started FundamentalScoreRun: ${parsed.id}`);
    }
    if (parsed.committedAt !== undefined) {
      throw new InvariantError(`started FundamentalScoreRun 不应有 committedAt: ${parsed.id}`);
    }
    const existing = this.runs.get(parsed.id);
    if (existing !== undefined && runJson(existing) !== runJson(parsed)) {
      throw new InvariantError(`FundamentalScoreRun identity 冲突且不得覆盖: ${parsed.id}`);
    }
    if (existing === undefined) this.runs.set(parsed.id, copy(parsed));
  }

  async commit(input: {
    readonly run: FundamentalScoreRun;
    readonly results: readonly FundamentalScoreResult[];
  }): Promise<void> {
    const run = parseRun(input.run);
    const parsedResults = input.results.map(parseResult);
    assertRunForCommit(run, parsedResults);
    const existing = this.runs.get(run.id);
    if (existing === undefined) {
      throw new InvariantError(`FundamentalScoreRun 未先 saveStarted: ${run.id}`);
    }
    if (existing.status !== 'started') {
      const oldResults = [...(this.results.get(run.id)?.values() ?? [])];
      if (runJson(existing) === runJson(run) && sameResults(oldResults, parsedResults)) return;
      throw new InvariantError(`FundamentalScoreRun 已进入终态且不得重复提交: ${run.id}`);
    }
    assertRunIdentity(existing, run);

    // Prepare all copies before mutating either map, matching the Drizzle transaction boundary.
    const nextRun = copy(run);
    const nextResults =
      run.status === 'committed'
        ? new Map(sortedResults(parsedResults).map((result) => [result.stockId, copy(result)]))
        : new Map<string, FundamentalScoreResult>();
    this.runs.set(run.id, nextRun);
    this.results.set(run.id, nextResults);
  }

  async findById(id: string): Promise<FundamentalScoreRun | null> {
    const run = this.runs.get(id);
    return run === undefined ? null : copy(run);
  }

  async list(
    input: {
      readonly scoreVersionId?: string;
      readonly status?: FundamentalScoreRun['status'];
      readonly asOf?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<readonly FundamentalScoreRun[]> {
    const rows = [...this.runs.values()]
      .filter(
        (run) =>
          (input.scoreVersionId === undefined || run.scoreVersionId === input.scoreVersionId) &&
          (input.status === undefined || run.status === input.status) &&
          (input.asOf === undefined || run.asOf.getTime() === input.asOf.getTime()),
      )
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
      );
    return (input.limit === undefined ? rows : rows.slice(0, Math.max(0, input.limit))).map(copy);
  }

  async listResults(runId: string): Promise<readonly FundamentalScoreResult[]> {
    const run = this.runs.get(runId);
    if (run === undefined || run.status !== 'committed') return [];
    return sortedResults([...(this.results.get(runId)?.values() ?? [])]).map(copy);
  }
}
