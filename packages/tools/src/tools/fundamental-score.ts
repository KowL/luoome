import { createHash } from 'node:crypto';
import {
  assertFinancialVintageInvariants,
  assertFundamentalScoreVersionInvariants,
  evaluateFundamentalFactor,
  type FinancialFact,
  type FinancialMissingReasonSchema,
  FinancialVintageSchema,
  FUNDAMENTAL_FACTOR_REGISTRY_HASH,
  FUNDAMENTAL_FACTOR_REGISTRY_VERSION,
  FUNDAMENTAL_NORMALIZATION_VERSION,
  FUNDAMENTAL_ROUNDING,
  type FundamentalScoreResult,
  FundamentalScoreResultSchema,
  type FundamentalScoreRun,
  type FundamentalScoreRunRepository,
  FundamentalScoreRunSchema,
  type FundamentalScoreVersion,
  type FundamentalScoreVersionRepository,
  FundamentalScoreVersionSchema,
  getFundamentalFactor,
  runFundamentalScore,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errInvalidInput, errNotFound } from '../define-tool.js';

const STOCK_ID_LIMIT = 10_000;

const FundamentalStockIdsSchema = z
  .array(z.string().trim().min(1).max(100))
  .min(1)
  .max(STOCK_ID_LIMIT)
  .superRefine((stockIds, ctx) => {
    if (new Set(stockIds).size !== stockIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'stockIds 必须唯一；universeMemberChecksum 必须对应确定的股票集合',
      });
    }
  });

/**
 * This identity is deliberately code-owned.  The caller may choose the
 * universe/as-of identity, but cannot claim that a different evaluator ran.
 */
const evaluatorManifest = [
  'fundamental-score-evaluator-v1',
  FUNDAMENTAL_FACTOR_REGISTRY_VERSION,
  FUNDAMENTAL_FACTOR_REGISTRY_HASH,
  FUNDAMENTAL_NORMALIZATION_VERSION,
  FUNDAMENTAL_ROUNDING,
  'rank=score-desc-stock-id-asc-v1',
].join('|');

export const FUNDAMENTAL_SCORE_EVALUATOR_CODE_IDENTITY = createHash('sha256')
  .update(evaluatorManifest)
  .digest('hex');

export const RunFundamentalScoreInput = z
  .object({
    scoreVersionId: z.string().trim().min(1).max(200),
    asOf: z.coerce.date(),
    stockIds: FundamentalStockIdsSchema,
    universeSyncId: z.string().trim().min(1).max(200),
    universeMemberChecksum: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/),
    /** Must be explicit.  `false` still retains sideEffect=write. */
    persist: z.boolean(),
  })
  .strict();

export type FundamentalScoreRunView = FundamentalScoreRun;

const ScoreToolLimitations = z.array(z.string().min(1).max(500)).max(8);
const scoreLimitations = [
  'providerKind=mock 仅表示当前合成/mock 事实装配；gate=not-ready，不宣称 evaluation-ready 或 operational。',
  'score 是确定性的基本面规则分，不是收益概率、置信度、Advice 或交易授权。',
  '事实读取严格通过 FinancialFactRepository.resolveVintage，不回源当前接口，不以行情或股票目录补齐 PIT 数据。',
] as const;

export const RunFundamentalScoreOutput = z
  .object({
    providerKind: z.literal('mock'),
    gate: z.literal('not-ready'),
    run: FundamentalScoreRunSchema,
    scoreVersion: FundamentalScoreVersionSchema,
    version: FundamentalScoreVersionSchema,
    results: z.array(FundamentalScoreResultSchema),
    status: z.enum(['complete', 'partial', 'unavailable']),
    limitations: ScoreToolLimitations,
  })
  .strict();

export const GetFundamentalScoreInput = z.object({
  runId: z.string().trim().min(1).max(200),
});

export const GetFundamentalScoreOutput = z
  .object({
    providerKind: z.literal('mock'),
    gate: z.literal('not-ready'),
    run: FundamentalScoreRunSchema,
    /** `scoreVersion` is the canonical field; `version` keeps query clients explicit. */
    scoreVersion: FundamentalScoreVersionSchema,
    version: FundamentalScoreVersionSchema,
    results: z.array(FundamentalScoreResultSchema),
    status: z.enum(['started', 'committed', 'unavailable', 'failed']),
    limitations: ScoreToolLimitations,
  })
  .strict();

type ScoreRepositories = {
  readonly fundamentalScoreVersion: FundamentalScoreVersionRepository;
  readonly fundamentalScoreRun: FundamentalScoreRunRepository;
};

const scoreRepositories = (ctx: ToolContext): ScoreRepositories => {
  return {
    fundamentalScoreVersion: ctx.repos.fundamentalScoreVersion,
    fundamentalScoreRun: ctx.repos.fundamentalScoreRun,
  };
};

const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].sort();

const memberChecksumForStockIds = (stockIds: readonly string[]): string =>
  createHash('sha256').update(JSON.stringify(stockIds)).digest('hex');

const scoreVersionForInput = async (
  input: z.infer<typeof RunFundamentalScoreInput>,
  repos: ScoreRepositories,
): Promise<FundamentalScoreVersion> => {
  const version = await repos.fundamentalScoreVersion.findById(input.scoreVersionId);
  if (version === null || version === undefined) {
    throw new ScoreToolNotFound('FundamentalScoreVersion', input.scoreVersionId);
  }
  const parsed = FundamentalScoreVersionSchema.parse(version);
  assertFundamentalScoreVersionInvariants(parsed);
  if (parsed.status !== 'published' || parsed.publishedAt === undefined) {
    throw new ScoreToolInvalidInput(
      `scoreVersionId 只能引用 published FundamentalScoreVersion: ${input.scoreVersionId}`,
    );
  }
  return parsed;
};

const metricIdsForVersion = (version: FundamentalScoreVersion): string[] => {
  const metricIds: string[] = [];
  for (const component of version.components) {
    const factor = getFundamentalFactor(component.factorId);
    if (factor === undefined) {
      throw new Error(`score version 引用了未注册 factor: ${component.factorId}`);
    }
    metricIds.push(...factor.sourceMetricIds);
  }
  return uniqueSorted(metricIds);
};

const missingByMetricKey = (
  vintage: z.infer<typeof FinancialVintageSchema>,
): Map<
  string,
  {
    readonly reason: z.infer<typeof FinancialMissingReasonSchema>;
    readonly revisionIds: readonly string[];
  }
> => {
  const map = new Map<
    string,
    {
      readonly reason: z.infer<typeof FinancialMissingReasonSchema>;
      readonly revisionIds: readonly string[];
    }
  >();
  for (const missing of vintage.missing) {
    map.set(`${missing.stockId}|${missing.metricId}`, {
      reason: missing.reason,
      revisionIds: missing.revisionIds ?? [],
    });
  }
  return map;
};

const evaluateObservations = (input: {
  readonly version: FundamentalScoreVersion;
  readonly stockIds: readonly string[];
  readonly facts: readonly FinancialFact[];
  readonly missing: ReturnType<typeof missingByMetricKey>;
}): ReturnType<typeof evaluateFundamentalFactor>[] => {
  const observations: ReturnType<typeof evaluateFundamentalFactor>[] = [];
  for (const stockId of input.stockIds) {
    for (const component of input.version.components) {
      const factor = getFundamentalFactor(component.factorId);
      if (factor === undefined) throw new Error(`未注册 factor: ${component.factorId}`);
      const observation = evaluateFundamentalFactor({
        stockId,
        factor,
        facts: input.facts,
      });
      if (
        observation.rawValue !== undefined ||
        observation.missingReason !== 'no-eligible-vintage'
      ) {
        observations.push(observation);
        continue;
      }
      // The registered evaluator is still authoritative.  Replace only its
      // generic no-eligible-vintage reason with the strict resolver's precise
      // cutoff reason when one exists for a source metric.
      const sourceMissing = factor.sourceMetricIds
        .map((metricId) => input.missing.get(`${stockId}|${metricId}`))
        .find((item) => item !== undefined);
      if (sourceMissing === undefined) {
        observations.push(observation);
        continue;
      }
      observations.push({
        ...observation,
        sourceRevisionIds: [...new Set(sourceMissing.revisionIds)].sort(),
        missingReason: sourceMissing.reason,
      });
    }
  }
  return observations;
};

const asScoreRun = (value: unknown): FundamentalScoreRunView => {
  return FundamentalScoreRunSchema.parse(value);
};

const makeRun = (input: {
  readonly id: string;
  readonly version: FundamentalScoreVersion;
  readonly universeSyncId: string;
  readonly universeMemberChecksum: string;
  readonly asOf: Date;
  readonly vintageKey: string;
  readonly denominatorHash: string;
  readonly providerStatus: FundamentalScoreRunView['providerStatus'];
  readonly counts: FundamentalScoreRunView['counts'];
  readonly status: FundamentalScoreRunView['status'];
  readonly createdAt: Date;
  readonly committedAt?: Date;
  readonly terminalReason?: FundamentalScoreRunView['terminalReason'];
}): FundamentalScoreRunView =>
  FundamentalScoreRunSchema.parse({
    id: input.id,
    scoreVersionId: input.version.id,
    scoreVersionHash: input.version.definitionHash,
    registryHash: input.version.registryHash,
    universeSyncId: input.universeSyncId,
    universeMemberChecksum: input.universeMemberChecksum,
    asOf: new Date(input.asOf.getTime()),
    financialVintageKey: input.vintageKey,
    normalizerDenominatorHash: input.denominatorHash,
    counts: input.counts,
    providerStatus: input.providerStatus,
    evaluatorCodeIdentity: FUNDAMENTAL_SCORE_EVALUATOR_CODE_IDENTITY,
    status: input.status,
    createdAt: new Date(input.createdAt.getTime()),
    ...(input.committedAt === undefined
      ? {}
      : { committedAt: new Date(input.committedAt.getTime()) }),
    ...(input.terminalReason === undefined ? {} : { terminalReason: input.terminalReason }),
  });

const saveStarted = async (
  repo: FundamentalScoreRunRepository,
  run: FundamentalScoreRunView,
): Promise<void> => repo.saveStarted(run);

const commitRun = async (
  repo: FundamentalScoreRunRepository,
  run: FundamentalScoreRunView,
  results: readonly FundamentalScoreResult[],
): Promise<void> => {
  return repo.commit({ run, results });
};

class ScoreToolNotFound extends Error {
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super(`${entity} 不存在: ${id}`);
    this.entity = entity;
    this.id = id;
  }
}

class ScoreToolInvalidInput extends Error {}

const runFundamentalScoreToolHandler = async (
  input: z.infer<typeof RunFundamentalScoreInput>,
  ctx: ToolContext,
) => {
  const repos = scoreRepositories(ctx);
  let version: FundamentalScoreVersion;
  try {
    version = await scoreVersionForInput(input, repos);
  } catch (error) {
    if (error instanceof ScoreToolNotFound) return errNotFound(error.entity, error.id);
    if (error instanceof ScoreToolInvalidInput) return errInvalidInput(error.message);
    throw error;
  }

  const stockIds = uniqueSorted(input.stockIds);
  if (memberChecksumForStockIds(stockIds) !== input.universeMemberChecksum) {
    return errInvalidInput(
      'universeMemberChecksum 与排序后的 stockIds 不匹配；不能把不同股票池伪装成同一 evaluation identity',
    );
  }
  const metricIds = metricIdsForVersion(version);
  const vintage = FinancialVintageSchema.parse(
    await ctx.repos.financialFact.resolveVintage({
      stockIds,
      metricIds,
      asOf: input.asOf,
      policy: 'strict-pit-v1',
    }),
  );
  assertFinancialVintageInvariants(vintage);
  const observations = evaluateObservations({
    version,
    stockIds,
    facts: vintage.facts,
    missing: missingByMetricKey(vintage),
  });
  const runId = `fundamental-score-run-${globalThis.crypto.randomUUID()}`;
  const engine = runFundamentalScore({
    scoreRunId: runId,
    scoreVersion: version,
    stockIds,
    observations,
    dataAsOf: input.asOf,
    vintageKey: vintage.vintageKey,
  });
  const now = ctx.clock();
  const finalStatus: FundamentalScoreRunView['status'] =
    engine.status === 'unavailable' ? 'unavailable' : 'committed';
  const terminalReason =
    finalStatus === 'unavailable'
      ? {
          code: 'no-available-score',
          message: '没有任何满足 strict PIT 与 normalizer 门槛的可评分事实',
          observedAt: now,
        }
      : undefined;
  const finalRun = makeRun({
    id: runId,
    version,
    universeSyncId: input.universeSyncId,
    universeMemberChecksum: input.universeMemberChecksum,
    asOf: input.asOf,
    vintageKey: vintage.vintageKey,
    denominatorHash: engine.denominatorHash,
    providerStatus: vintage.status,
    counts: engine.counts,
    status: finalStatus,
    createdAt: now,
    committedAt: now,
    ...(terminalReason === undefined ? {} : { terminalReason }),
  });

  if (input.persist) {
    const startedRun = makeRun({
      id: runId,
      version,
      universeSyncId: input.universeSyncId,
      universeMemberChecksum: input.universeMemberChecksum,
      asOf: input.asOf,
      vintageKey: vintage.vintageKey,
      denominatorHash: engine.denominatorHash,
      providerStatus: vintage.status,
      counts: engine.counts,
      status: 'started',
      createdAt: now,
    });
    await saveStarted(repos.fundamentalScoreRun, startedRun);
    if (finalStatus === 'committed') {
      await commitRun(repos.fundamentalScoreRun, finalRun, engine.results);
    } else {
      await commitRun(repos.fundamentalScoreRun, finalRun, []);
    }
  }

  return {
    providerKind: 'mock' as const,
    gate: 'not-ready' as const,
    run: finalRun,
    scoreVersion: version,
    version,
    results: engine.status === 'unavailable' ? [] : [...engine.results],
    status: engine.status,
    limitations: [...scoreLimitations],
  };
};

export const runFundamentalScoreTool = defineTool({
  name: 'run_fundamental_score',
  description:
    '读取已发布 score version 与 strict PIT FinancialFact，执行确定性的基本面横截面评分；persist=false 仍声明 write，mock 输出始终 gate=not-ready',
  sideEffect: 'write',
  input: RunFundamentalScoreInput,
  output: RunFundamentalScoreOutput,
  handler: runFundamentalScoreToolHandler,
});

export const getFundamentalScoreTool = defineTool({
  name: 'get_fundamental_score',
  description:
    '只读查询已持久化 FundamentalScoreRun、score version 与逐股逐因子解释；unavailable/failed 不伪造空成功',
  sideEffect: 'read',
  input: GetFundamentalScoreInput,
  output: GetFundamentalScoreOutput,
  handler: async (input, ctx) => {
    const repos = scoreRepositories(ctx);
    const rawRun = await repos.fundamentalScoreRun.findById(input.runId);
    if (rawRun === null || rawRun === undefined)
      return errNotFound('FundamentalScoreRun', input.runId);
    const run = asScoreRun(rawRun);
    const rawVersion = await repos.fundamentalScoreVersion.findById(run.scoreVersionId);
    if (rawVersion === null || rawVersion === undefined) {
      return errAdapterError(
        'fundamental-score-repository',
        `score run 引用的 score version 不存在: ${run.scoreVersionId}`,
        false,
      );
    }
    const scoreVersion = FundamentalScoreVersionSchema.parse(rawVersion);
    assertFundamentalScoreVersionInvariants(scoreVersion);
    const rawResults = await repos.fundamentalScoreRun.listResults(run.id);
    const results = (rawResults ?? []).map((result) => FundamentalScoreResultSchema.parse(result));
    if (results.some((result) => result.scoreRunId !== run.id)) {
      throw new Error('FundamentalScoreResult.scoreRunId 与查询 run 不一致');
    }
    if (run.status === 'committed' && results.length === 0) {
      return errAdapterError(
        'fundamental-score',
        `committed score run ${run.id} 没有可消费结果`,
        true,
      );
    }
    return {
      providerKind: 'mock' as const,
      gate: 'not-ready' as const,
      run,
      scoreVersion,
      version: scoreVersion,
      results: run.status === 'committed' ? results : [],
      status: run.status,
      limitations: [...scoreLimitations],
    };
  },
});
