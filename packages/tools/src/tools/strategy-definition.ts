import {
  assertStrategyVersionInvariants,
  classifyStrategyResult,
  diffStrategyDefinitions,
  diffStrategyRunViews,
  readStrategyRunSnapshot,
  StrategyDefinitionDiffSchema,
  StrategyDslV1Schema,
  StrategyResultViewSchema,
  StrategyRunDiffSchema,
  StrategyRunInputSnapshotV3Schema,
  StrategySchema,
  type StrategyVersion,
  StrategyVersionSchema,
  strategyDefinitionHash,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import {
  captureStrategyComparisonSnapshot,
  StrategyComparisonInputIdentitySchema,
} from '../internal/strategy-comparison-snapshot.js';
import { type RunStrategyInput, RunStrategyOutput, runStrategyTool } from './run-strategy.js';
import { collectStrategyInsightFacts, StrategyInsightFactsSchema } from './strategy-insight.js';

export { StrategyComparisonInputIdentitySchema };

export const CompareStrategyDefinitionsInput = z.object({
  strategyId: z.string().min(1),
  fromVersionId: z.string().min(1).optional(),
  toVersionId: z.string().min(1).optional(),
});

export const CompareStrategyDefinitionsOutput = z.object({
  strategy: StrategySchema,
  fromVersion: StrategyVersionSchema,
  toVersion: StrategyVersionSchema,
  diff: StrategyDefinitionDiffSchema,
});

export const compareStrategyDefinitionsTool = defineTool({
  name: 'compare_strategy_definitions',
  description: '比较同一 Strategy 的基线版本与草案定义，返回稳定的字段级 diff',
  sideEffect: 'read',
  input: CompareStrategyDefinitionsInput,
  output: CompareStrategyDefinitionsOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    const versions = await ctx.repos.strategy.listVersions(strategy.id);
    const fromId = input.fromVersionId ?? versions.at(-2)?.id;
    const toId = input.toVersionId ?? versions.at(-1)?.id;
    if (fromId === undefined || toId === undefined) {
      return errInvalidInput('definition diff 至少需要同一 Strategy 下两个版本');
    }
    const fromVersion = await ctx.repos.strategy.findVersionById(fromId);
    const toVersion = await ctx.repos.strategy.findVersionById(toId);
    if (fromVersion === null) return errNotFound('StrategyVersion', fromId);
    if (toVersion === null) return errNotFound('StrategyVersion', toId);
    if (
      fromVersion.strategyId !== strategy.id ||
      toVersion.strategyId !== strategy.id ||
      fromVersion.id === toVersion.id
    ) {
      return errInvalidInput('比较版本必须是同一 Strategy 下的两个不同版本');
    }
    return {
      strategy,
      fromVersion,
      toVersion,
      diff: diffStrategyDefinitions(
        fromVersion.definition,
        toVersion.definition,
        fromVersion.definitionHash,
        toVersion.definitionHash,
      ),
    };
  },
});

const AgentTraceInputSchema = z.object({
  toolName: z.string().min(1),
  input: z.unknown(),
  output: z.unknown(),
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
});

export const ProposeStrategyVersionDraftInput = z.object({
  strategyId: z.string().min(1),
  baseVersionId: z.string().min(1).optional(),
  definition: StrategyDslV1Schema,
  changeSummary: z.string().min(1).max(500),
  factReferences: z.array(z.string().min(1).max(200)).min(1).max(50),
  agentTrace: z.array(AgentTraceInputSchema).max(100).default([]),
  windowDays: z.number().int().min(7).max(180).default(30),
});

export const ProposeStrategyVersionDraftOutput = z.object({
  strategy: StrategySchema,
  baseVersion: StrategyVersionSchema,
  draft: StrategyVersionSchema,
  diff: StrategyDefinitionDiffSchema,
  facts: StrategyInsightFactsSchema,
  audit: z.object({
    factReferences: z.array(z.string()),
    agentTrace: z.array(AgentTraceInputSchema),
    persisted: z.literal(false),
  }),
});

/**
 * 将已受控的 AI 输出封装为普通 StrategyVersion 草案；该 tool 不落库。
 * 用户确认后仍须调用 create_strategy_version → validate → publish。
 */
export const prepareStrategyVersionDraft = async (
  input: z.infer<typeof ProposeStrategyVersionDraftInput>,
  ctx: ToolContext,
) => {
  const strategy = await ctx.repos.strategy.findById(input.strategyId);
  if (strategy === null) return errNotFound('Strategy', input.strategyId);
  if (strategy.owner === 'builtin') return errInvalidInput('builtin Strategy 不可生成修改草案');
  const versions = await ctx.repos.strategy.listVersions(strategy.id);
  const base =
    (input.baseVersionId === undefined
      ? (strategy.currentVersionId ?? versions.at(-1)?.id)
      : input.baseVersionId) ?? undefined;
  if (base === undefined) return errInvalidInput('Strategy 没有可供分析的基线版本');
  const baseVersion = await ctx.repos.strategy.findVersionById(base);
  if (baseVersion === null) return errNotFound('StrategyVersion', base);
  if (baseVersion.strategyId !== strategy.id) return errInvalidInput('基线版本不属于该 Strategy');
  const facts = await collectStrategyInsightFacts(strategy.id, input.windowDays, ctx);
  if (facts === null) return errNotFound('Strategy', strategy.id);
  const allowed = new Set([
    ...facts.facts.map((fact) => fact.id),
    ...facts.facts.flatMap((fact) => fact.evidenceIds),
  ]);
  const unknownRefs = input.factReferences.filter((ref) => !allowed.has(ref));
  if (unknownRefs.length > 0) {
    return errInvalidInput(`事实引用不存在或不在允许输入范围: ${unknownRefs.join(', ')}`);
  }
  const latestVersion = versions.at(-1);
  const versionNumber = (latestVersion?.version ?? 0) + 1;
  const now = ctx.clock();
  const draft: StrategyVersion = StrategyVersionSchema.parse({
    id: `${strategy.id}-draft-${globalThis.crypto.randomUUID().slice(0, 8)}`,
    strategyId: strategy.id,
    version: versionNumber,
    definition: input.definition,
    definitionHash: strategyDefinitionHash(input.definition),
    parentVersionId: baseVersion.id,
    changeSummary: input.changeSummary,
    factReferences: input.factReferences,
    agentTrace: input.agentTrace,
    validationStatus: 'pending',
    validationErrors: [],
    createdAt: now,
  });
  assertStrategyVersionInvariants(draft, 'user');
  return {
    strategy,
    baseVersion,
    draft,
    diff: diffStrategyDefinitions(
      baseVersion.definition,
      draft.definition,
      baseVersion.definitionHash,
      draft.definitionHash,
    ),
    facts,
    audit: {
      factReferences: [...input.factReferences],
      agentTrace: [...input.agentTrace],
      persisted: false as const,
    },
  };
};

export const proposeStrategyVersionDraftTool = defineTool({
  name: 'propose_strategy_version_draft',
  description: '基于可审计事实校验并生成未持久化的 StrategyVersion 草案，不会发布或正式运行',
  sideEffect: 'external',
  input: ProposeStrategyVersionDraftInput,
  output: ProposeStrategyVersionDraftOutput,
  handler: prepareStrategyVersionDraft,
});

export const TrialStrategyVersionInput = z.object({
  strategyId: z.string().min(1),
  baseVersionId: z.string().min(1),
  draftVersionId: z.string().min(1),
  stockIds: z.array(z.string().min(1)).min(1).max(500),
  mode: z.enum(['scan', 'replay']).default('scan'),
  asOf: z.coerce.date().optional(),
  revisionCutoff: z.coerce.date().optional(),
});

export const TrialStrategyVersionOutput = z.object({
  base: RunStrategyOutput,
  draft: RunStrategyOutput,
  diff: StrategyRunDiffSchema,
  stockIds: z.array(z.string()),
  persisted: z.literal(false),
  inputIdentity: StrategyComparisonInputIdentitySchema,
  diagnostics: z.object({
    base: z.array(StrategyResultViewSchema),
    draft: z.array(StrategyResultViewSchema),
    missingBaseStockIds: z.array(z.string()),
    missingDraftStockIds: z.array(z.string()),
    excludedByUniverseStockIds: z.array(z.string()),
  }),
});

/** 两个不可变定义共享一次冻结采集，不写 operational current。 */
export const trialStrategyVersionTool = defineTool({
  name: 'trial_strategy_version',
  description: '用同一股票样本对比 Strategy 基线与草案；persist=false，不产生正式 StrategyRun',
  sideEffect: 'external',
  input: TrialStrategyVersionInput,
  output: TrialStrategyVersionOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    const [baseVersion, draftVersion] = await Promise.all([
      ctx.repos.strategy.findVersionById(input.baseVersionId),
      ctx.repos.strategy.findVersionById(input.draftVersionId),
    ]);
    if (baseVersion === null) return errNotFound('StrategyVersion', input.baseVersionId);
    if (draftVersion === null) return errNotFound('StrategyVersion', input.draftVersionId);
    if (
      baseVersion.strategyId !== strategy.id ||
      draftVersion.strategyId !== strategy.id ||
      baseVersion.id === draftVersion.id
    ) {
      return errInvalidInput('基线和草案必须是同一 Strategy 下的两个不同版本');
    }
    if (baseVersion.validationStatus !== 'valid' || draftVersion.validationStatus !== 'valid')
      return errInvalidInput('对照必须使用 valid version');
    if (strategy.status !== 'active' && strategy.status !== 'draft')
      return errInvalidInput('暂停或归档的 Strategy 不接受试跑');
    if (
      JSON.stringify(baseVersion.definition.universe) !==
      JSON.stringify(draftVersion.definition.universe)
    )
      return errInvalidInput('受控对照必须使用相同 universe 定义');
    if (input.mode === 'replay' && input.asOf === undefined)
      return errInvalidInput('mode=replay 时 asOf 必填');
    if (input.mode === 'scan' && (input.asOf !== undefined || input.revisionCutoff !== undefined))
      return errInvalidInput('scan 不接受历史 asOf/revisionCutoff；请使用 replay');
    if (input.revisionCutoff !== undefined && input.revisionCutoff > ctx.clock())
      return errInvalidInput('revisionCutoff 不能在未来');
    const snapshot = await captureStrategyComparisonSnapshot({
      ctx,
      versions: [baseVersion, draftVersion],
      stockIds: input.stockIds,
      mode: input.mode,
      ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
      ...(input.revisionCutoff === undefined ? {} : { revisionCutoff: input.revisionCutoff }),
    });
    if (input.mode === 'replay' && !snapshot.universeAvailable)
      return errInvalidInput('历史对照缺少指定时点的 PIT 股票池');
    const common = {
      strategyId: input.strategyId,
      stockIds: snapshot.stockIds,
      mode: input.mode,
      persist: false as const,
      ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
      ...(snapshot.identity.revisionCutoff === undefined
        ? {}
        : { revisionCutoff: snapshot.identity.revisionCutoff }),
    } satisfies z.input<typeof RunStrategyInput>;
    const [base, draft] = await Promise.all([
      runStrategyTool.execute({ ...common, versionId: baseVersion.id }, snapshot.ctx),
      runStrategyTool.execute({ ...common, versionId: draftVersion.id }, snapshot.ctx),
    ]);
    if (!base.ok) return base;
    if (!draft.ok) return draft;
    for (const result of [base.data, draft.data]) {
      result.run.inputSnapshot = StrategyRunInputSnapshotV3Schema.parse({
        ...StrategyRunInputSnapshotV3Schema.parse(result.run.inputSnapshot),
        dataCheckpoint: {
          id: `memory:${snapshot.identity.snapshotHash}`,
          dataAsOf: snapshot.identity.dataAsOf,
          checksum: snapshot.identity.snapshotHash,
        },
      });
    }
    const diff = diffStrategyRunViews({
      fromRun: base.data.run,
      toRun: draft.data.run,
      fromViews: base.data.results.map((result) =>
        classifyStrategyResult(baseVersion.definition, result),
      ),
      toViews: draft.data.results.map((result) =>
        classifyStrategyResult(draftVersion.definition, result),
      ),
    });
    return {
      base: base.data,
      draft: draft.data,
      diff,
      stockIds: snapshot.stockIds,
      persisted: false as const,
      inputIdentity: snapshot.identity,
      diagnostics: {
        base: base.data.results.map((result) =>
          classifyStrategyResult(baseVersion.definition, result),
        ),
        draft: draft.data.results.map((result) =>
          classifyStrategyResult(draftVersion.definition, result),
        ),
        missingBaseStockIds: readStrategyRunSnapshot(base.data.run.inputSnapshot).stockIds.filter(
          (id) => !base.data.results.some((result) => result.stockId === id),
        ),
        missingDraftStockIds: readStrategyRunSnapshot(draft.data.run.inputSnapshot).stockIds.filter(
          (id) => !draft.data.results.some((result) => result.stockId === id),
        ),
        excludedByUniverseStockIds: snapshot.stockIds.filter(
          (id) => !readStrategyRunSnapshot(base.data.run.inputSnapshot).stockIds.includes(id),
        ),
      },
    };
  },
});
