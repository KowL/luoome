import {
  assertStrategyInvariants,
  assertStrategyVersionInvariants,
  inspectStrategyDefinitionReferences,
  StrategyDslV1Schema,
  StrategySchema,
  type StrategyVersion,
  StrategyVersionSchema,
  strategyDefinitionHash,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const StrategyFilterSchema = z
  .object({
    status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
    owner: z.enum(['builtin', 'user']).optional(),
  })
  .optional();

export const ListStrategiesInput = z.object({ filter: StrategyFilterSchema });
export const ListStrategiesOutput = z.object({
  strategies: z.array(StrategySchema),
  total: z.number().int().nonnegative(),
});

export const listStrategiesTool = defineTool({
  name: 'list_strategies',
  description: '列出 Strategy，可按状态与 owner 过滤',
  sideEffect: 'read',
  input: ListStrategiesInput,
  output: ListStrategiesOutput,
  handler: async (input, ctx) => {
    const strategies = await ctx.repos.strategy.list(
      input.filter === undefined
        ? undefined
        : {
            ...(input.filter.status === undefined ? {} : { status: input.filter.status }),
            ...(input.filter.owner === undefined ? {} : { owner: input.filter.owner }),
          },
    );
    return { strategies, total: strategies.length };
  },
});

export const GetStrategyInput = z.object({ strategyId: z.string().min(1) });
export const GetStrategyOutput = z.object({
  strategy: StrategySchema,
  versions: z.array(StrategyVersionSchema),
});

export const getStrategyTool = defineTool({
  name: 'get_strategy',
  description: '查询 Strategy 及其不可变版本历史',
  sideEffect: 'read',
  input: GetStrategyInput,
  output: GetStrategyOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    return { strategy, versions: await ctx.repos.strategy.listVersions(strategy.id) };
  },
});

export const CreateStrategyInput = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,63}$/)
    .optional(),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(1000),
  copyFromStrategyId: z.string().min(1).optional(),
});
export const CreateStrategyOutput = z.object({
  strategy: StrategySchema,
  copiedVersion: StrategyVersionSchema.optional(),
});

export const createStrategyTool = defineTool({
  name: 'create_strategy',
  description: '创建用户 Strategy；内置 Strategy 只能通过 copyFromStrategyId 复制',
  sideEffect: 'write',
  input: CreateStrategyInput,
  output: CreateStrategyOutput,
  handler: async (input, ctx) => {
    const id = input.id ?? `strategy-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    if ((await ctx.repos.strategy.findById(id)) !== null) {
      return errInvalidInput(`Strategy id 已存在: ${id}`);
    }
    let sourceVersion: StrategyVersion | undefined;
    let sourceId: string | undefined;
    if (input.copyFromStrategyId !== undefined) {
      const source = await ctx.repos.strategy.findById(input.copyFromStrategyId);
      if (source === null) return errNotFound('Strategy', input.copyFromStrategyId);
      if (source.currentVersionId === undefined) {
        return errInvalidInput(`源 Strategy 没有 currentVersion: ${source.id}`);
      }
      const foundVersion = await ctx.repos.strategy.findVersionById(source.currentVersionId);
      if (foundVersion === null) return errNotFound('StrategyVersion', source.currentVersionId);
      sourceVersion = foundVersion;
      sourceId = source.id;
    }
    const now = ctx.clock();
    const strategy = StrategySchema.parse({
      id,
      name: input.name,
      description: input.description,
      owner: 'user',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });
    assertStrategyInvariants(strategy);
    await ctx.repos.strategy.save(strategy);

    if (sourceVersion === undefined || sourceId === undefined) return { strategy };
    const copiedVersion = StrategyVersionSchema.parse({
      id: `${id}-v1`,
      strategyId: id,
      version: 1,
      definition: sourceVersion.definition,
      definitionHash: sourceVersion.definitionHash,
      changeSummary: `复制自 ${sourceId}@${sourceVersion.version}`,
      validationStatus: 'pending',
      validationErrors: [],
      createdAt: now,
    });
    await ctx.repos.strategy.saveVersion(copiedVersion);
    return { strategy, copiedVersion };
  },
});

export const CreateStrategyVersionInput = z.object({
  strategyId: z.string().min(1),
  definition: StrategyDslV1Schema,
  changeSummary: z.string().max(500).optional(),
});
export const CreateStrategyVersionOutput = z.object({ version: StrategyVersionSchema });

export const createStrategyVersionTool = defineTool({
  name: 'create_strategy_version',
  description: '为用户 Strategy 创建严格递增的 draft version',
  sideEffect: 'write',
  input: CreateStrategyVersionInput,
  output: CreateStrategyVersionOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    if (strategy.owner === 'builtin') {
      return errInvalidInput('builtin Strategy 不可修改；请先用 create_strategy 复制');
    }
    const versions = await ctx.repos.strategy.listVersions(strategy.id);
    const parent = versions.at(-1);
    const number = (parent?.version ?? 0) + 1;
    const now = ctx.clock();
    const version = StrategyVersionSchema.parse({
      id: `${strategy.id}-v${number}-${globalThis.crypto.randomUUID().slice(0, 8)}`,
      strategyId: strategy.id,
      version: number,
      definition: input.definition,
      definitionHash: strategyDefinitionHash(input.definition),
      ...(parent === undefined ? {} : { parentVersionId: parent.id }),
      ...(input.changeSummary === undefined ? {} : { changeSummary: input.changeSummary }),
      validationStatus: 'pending',
      validationErrors: [],
      createdAt: now,
    });
    assertStrategyVersionInvariants(version, 'user');
    await ctx.repos.strategy.saveVersion(version);
    return { version };
  },
});

export const ValidateStrategyVersionInput = z.object({ versionId: z.string().min(1) });
export const ValidateStrategyVersionOutput = z.object({
  version: StrategyVersionSchema,
  referencedFields: z.array(z.string()),
  requiredLookback: z.number().int().nonnegative(),
});

export const validateStrategyVersionTool = defineTool({
  name: 'validate_strategy_version',
  description: '静态校验 StrategyVersion 的字段路径与数据需求并回写校验结果（不会运行交易）',
  sideEffect: 'write',
  input: ValidateStrategyVersionInput,
  output: ValidateStrategyVersionOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.strategy.findVersionById(input.versionId);
    if (existing === null) return errNotFound('StrategyVersion', input.versionId);
    const strategy = await ctx.repos.strategy.findById(existing.strategyId);
    if (strategy === null) return errNotFound('Strategy', existing.strategyId);
    if (strategy.owner === 'builtin') {
      return errInvalidInput('builtin StrategyVersion 不可修改');
    }
    if (existing.publishedAt !== undefined) {
      return errInvalidInput('published StrategyVersion 不可重新校验修改');
    }
    const inspected = inspectStrategyDefinitionReferences(existing.definition);
    const version = StrategyVersionSchema.parse({
      ...existing,
      validationStatus: inspected.validationErrors.length === 0 ? 'valid' : 'invalid',
      validationErrors: inspected.validationErrors,
    });
    await ctx.repos.strategy.saveVersion(version);
    return {
      version,
      referencedFields: inspected.paths,
      requiredLookback: inspected.requiredLookback,
    };
  },
});

export const PublishStrategyVersionInput = z.object({ versionId: z.string().min(1) });
export const PublishStrategyVersionOutput = z.object({
  strategy: StrategySchema,
  version: StrategyVersionSchema,
});

export const publishStrategyVersionTool = defineTool({
  name: 'publish_strategy_version',
  description:
    '发布 valid StrategyVersion 并原子切换 currentVersion；发布会把 paused 的 Strategy 置回 active（与 resume_strategy 等价效果）',
  sideEffect: 'write',
  input: PublishStrategyVersionInput,
  output: PublishStrategyVersionOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.strategy.findVersionById(input.versionId);
    if (existing === null) return errNotFound('StrategyVersion', input.versionId);
    const strategy = await ctx.repos.strategy.findById(existing.strategyId);
    if (strategy === null) return errNotFound('Strategy', existing.strategyId);
    if (strategy.owner === 'builtin') return errInvalidInput('builtin StrategyVersion 不可修改');
    if (existing.validationStatus !== 'valid') {
      return errInvalidInput('只能发布 validationStatus=valid 的 StrategyVersion');
    }
    const publishedAt = ctx.clock();
    await ctx.repos.strategy.publishVersion(strategy.id, existing.id, publishedAt);
    const activated = await ctx.repos.strategy.findById(strategy.id);
    if (activated === null) return errNotFound('Strategy', strategy.id);
    const version = await ctx.repos.strategy.findVersionById(existing.id);
    if (version === null) return errNotFound('StrategyVersion', existing.id);
    return { strategy: activated, version };
  },
});

export const PauseStrategyInput = z.object({ strategyId: z.string().min(1) });
export const PauseStrategyOutput = z.object({ strategy: StrategySchema });

export const pauseStrategyTool = defineTool({
  name: 'pause_strategy',
  description: '暂停用户 Strategy；不触发任何交易',
  sideEffect: 'write',
  input: PauseStrategyInput,
  output: PauseStrategyOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    if (strategy.owner === 'builtin') return errInvalidInput('builtin Strategy 不可修改');
    const paused = StrategySchema.parse({ ...strategy, status: 'paused', updatedAt: ctx.clock() });
    await ctx.repos.strategy.save(paused);
    return { strategy: paused };
  },
});

export const ResumeStrategyInput = z.object({ strategyId: z.string().min(1) });
export const ResumeStrategyOutput = z.object({ strategy: StrategySchema });

export const resumeStrategyTool = defineTool({
  name: 'resume_strategy',
  description:
    '恢复 paused 的用户 Strategy 为 active；publish_strategy_version 发布新版本也会隐式置回 active',
  sideEffect: 'write',
  input: ResumeStrategyInput,
  output: ResumeStrategyOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    if (strategy.owner === 'builtin') return errInvalidInput('builtin Strategy 不可修改');
    if (strategy.status !== 'paused') {
      return errInvalidInput(`只有 paused 的 Strategy 可恢复: ${strategy.id}`);
    }
    if (strategy.currentVersionId === undefined) {
      return errInvalidInput('恢复 active 需要先 publish 一个 valid StrategyVersion');
    }
    const resumed = StrategySchema.parse({
      ...strategy,
      status: 'active',
      updatedAt: ctx.clock(),
    });
    assertStrategyInvariants(resumed);
    await ctx.repos.strategy.save(resumed);
    return { strategy: resumed };
  },
});
