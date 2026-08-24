import {
  assertFundamentalScoreResultInvariants,
  assertFundamentalScoreRunCommitInvariants,
  assertFundamentalScoreRunInvariants,
  assertFundamentalScoreVersionInvariants,
  type FundamentalScoreResult,
  FundamentalScoreResultSchema,
  type FundamentalScoreRun,
  FundamentalScoreRunSchema,
  type FundamentalScoreVersion,
  FundamentalScoreVersionSchema,
  InvariantError,
} from '@luoome/core';

/** Repository boundary copy: callers must not be able to mutate stored dates/JSON. */
export const copy = <T>(value: T): T => structuredClone(value);

const canonicalize = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

const normalizeVersion = (version: FundamentalScoreVersion): FundamentalScoreVersion => ({
  ...version,
  components: [...version.components].sort((left, right) =>
    left.factorId.localeCompare(right.factorId),
  ),
});

export const parseVersion = (value: FundamentalScoreVersion): FundamentalScoreVersion => {
  const parsed = FundamentalScoreVersionSchema.parse(copy(value));
  assertFundamentalScoreVersionInvariants(parsed);
  return copy(normalizeVersion(parsed));
};

export const versionJson = (version: FundamentalScoreVersion): string =>
  canonicalJson(normalizeVersion(version));

/** Definition identity excludes lifecycle fields; it is immutable once the draft is persisted. */
export const versionDefinitionJson = (version: FundamentalScoreVersion): string =>
  canonicalJson({
    id: version.id,
    version: version.version,
    registryVersion: version.registryVersion,
    registryHash: version.registryHash,
    normalizationVersion: version.normalizationVersion,
    components: version.components,
    missingPolicy: version.missingPolicy,
    rounding: version.rounding,
    definitionHash: version.definitionHash,
    createdAt: version.createdAt,
  });

export const assertVersionSaveTransition = (
  existing: FundamentalScoreVersion,
  incoming: FundamentalScoreVersion,
): void => {
  if (versionJson(existing) === versionJson(incoming)) return;
  if (existing.status === 'retired') {
    throw new InvariantError(`已 retired 的 FundamentalScoreVersion 不可变更: ${existing.id}`);
  }
  if (versionDefinitionJson(existing) !== versionDefinitionJson(incoming)) {
    throw new InvariantError(`FundamentalScoreVersion 定义冲突且不得覆盖: ${existing.id}`);
  }
  if (existing.status === 'published') {
    if (incoming.status !== 'retired') {
      throw new InvariantError(`已 published 的 FundamentalScoreVersion 不可变更: ${existing.id}`);
    }
    if (existing.publishedAt?.getTime() !== incoming.publishedAt?.getTime()) {
      throw new InvariantError(`publishedAt 不可在 retired 转换时改写: ${existing.id}`);
    }
    return;
  }
  if (incoming.status === 'draft') {
    throw new InvariantError(`FundamentalScoreVersion draft identity 冲突: ${existing.id}`);
  }
  if (incoming.status === 'published' && incoming.publishedAt === undefined) {
    throw new InvariantError('published FundamentalScoreVersion 必须有 publishedAt');
  }
  if (incoming.status === 'retired' && incoming.publishedAt !== undefined) {
    throw new InvariantError('retired FundamentalScoreVersion 不应补写 publishedAt');
  }
};

export const parseRun = (value: FundamentalScoreRun): FundamentalScoreRun =>
  (() => {
    const parsed = FundamentalScoreRunSchema.parse(copy(value));
    assertFundamentalScoreRunInvariants(parsed);
    return copy(parsed);
  })();

export const runIdentityJson = (run: FundamentalScoreRun): string =>
  canonicalJson({
    id: run.id,
    scoreVersionId: run.scoreVersionId,
    scoreVersionHash: run.scoreVersionHash,
    registryHash: run.registryHash,
    universeSyncId: run.universeSyncId,
    universeMemberChecksum: run.universeMemberChecksum,
    asOf: run.asOf,
    financialVintageKey: run.financialVintageKey,
    normalizerDenominatorHash: run.normalizerDenominatorHash,
    counts: run.counts,
    providerStatus: run.providerStatus,
    evaluatorCodeIdentity: run.evaluatorCodeIdentity,
    createdAt: run.createdAt,
  });

export const runJson = (run: FundamentalScoreRun): string => canonicalJson(run);

export const parseResult = (value: FundamentalScoreResult): FundamentalScoreResult => {
  const parsed = FundamentalScoreResultSchema.parse(copy(value));
  assertFundamentalScoreResultInvariants(parsed);
  return copy({
    ...parsed,
    components: [...parsed.components].sort((left, right) =>
      left.factorId.localeCompare(right.factorId),
    ),
  });
};

export const resultJson = (result: FundamentalScoreResult): string => canonicalJson(result);

export const compareResults = (
  left: FundamentalScoreResult,
  right: FundamentalScoreResult,
): number =>
  (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER) ||
  left.stockId.localeCompare(right.stockId);

export const assertRunForCommit = (
  run: FundamentalScoreRun,
  results: readonly FundamentalScoreResult[],
): void => {
  if (run.status === 'started') {
    throw new InvariantError(`started FundamentalScoreRun 不能 commit: ${run.id}`);
  }
  assertFundamentalScoreRunCommitInvariants({ run, results });
};

export const assertRunIdentity = (
  existing: FundamentalScoreRun,
  incoming: FundamentalScoreRun,
): void => {
  if (runIdentityJson(existing) !== runIdentityJson(incoming)) {
    throw new InvariantError(`FundamentalScoreRun identity 冲突且不得覆盖: ${existing.id}`);
  }
};
