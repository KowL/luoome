import { StrategyDslV1Schema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import {
  createStrategyTool,
  createStrategyVersionTool,
  publishStrategyVersionTool,
  validateStrategyVersionTool,
} from './strategy-lifecycle.js';

export const SaveStrategyVersionInput = z
  .object({
    action: z.enum(['create-strategy', 'save-version', 'validate', 'publish']),
    /** create-strategy 必填；save-version/validate/publish 用于归属校验。 */
    strategyId: z.string().min(1).optional(),
    name: z.string().min(1).max(80).optional(),
    description: z.string().min(1).max(1000).optional(),
    copyFromStrategyId: z.string().min(1).optional(),
    definition: StrategyDslV1Schema.optional(),
    versionId: z.string().min(1).optional(),
    changeSummary: z.string().max(500).optional(),
    parentVersionId: z.string().min(1).optional(),
    factReferences: z.array(z.string().min(1).max(200)).max(50).optional(),
    agentTrace: z
      .array(
        z.object({
          toolName: z.string().min(1),
          input: z.unknown(),
          output: z.unknown(),
          ok: z.boolean(),
          durationMs: z.number().nonnegative(),
        }),
      )
      .max(100)
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (input.action === 'create-strategy') {
      if (input.name === undefined) {
        ctx.addIssue({ code: 'custom', path: ['name'], message: 'create-strategy 需要 name' });
      }
      if (input.description === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['description'],
          message: 'create-strategy 需要 description',
        });
      }
    }
    if (input.action === 'save-version') {
      if (input.strategyId === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['strategyId'],
          message: 'save-version 需要 strategyId',
        });
      }
      if (input.definition === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['definition'],
          message: 'save-version 需要 definition',
        });
      }
    }
    if (input.action === 'validate' || input.action === 'publish') {
      if (input.versionId === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['versionId'],
          message: `${input.action} 需要 versionId`,
        });
      }
    }
  });

export const SaveStrategyVersionOutput = z.record(z.string(), z.unknown());

export const saveStrategyVersionTool = defineTool({
  name: 'save_strategy_version',
  description:
    '策略定义写入口：create-strategy 创建 Strategy；save-version 提交新 DSL 版本；validate 静态校验版本；publish 发布 valid 版本并切换 currentVersion',
  sideEffect: 'write',
  input: SaveStrategyVersionInput,
  output: SaveStrategyVersionOutput,
  handler: async (input, ctx) => {
    if (input.action === 'create-strategy') {
      const result = await createStrategyTool.execute(
        {
          ...(input.strategyId === undefined ? {} : { id: input.strategyId }),
          name: input.name as string,
          description: input.description as string,
          ...(input.copyFromStrategyId === undefined
            ? {}
            : { copyFromStrategyId: input.copyFromStrategyId }),
        },
        ctx,
      );
      if (!result.ok) return result;
      return { action: input.action, ...result.data };
    }
    if (input.action === 'save-version') {
      const result = await createStrategyVersionTool.execute(
        {
          strategyId: input.strategyId as string,
          definition: input.definition as z.infer<typeof StrategyDslV1Schema>,
          ...(input.changeSummary === undefined ? {} : { changeSummary: input.changeSummary }),
          ...(input.parentVersionId === undefined
            ? {}
            : { parentVersionId: input.parentVersionId }),
          ...(input.factReferences === undefined ? {} : { factReferences: input.factReferences }),
          ...(input.agentTrace === undefined ? {} : { agentTrace: input.agentTrace }),
        },
        ctx,
      );
      if (!result.ok) return result;
      return { action: input.action, ...result.data };
    }
    if (input.action === 'validate') {
      const result = await validateStrategyVersionTool.execute(
        {
          versionId: input.versionId as string,
          ...(input.strategyId === undefined ? {} : { strategyId: input.strategyId }),
        },
        ctx,
      );
      if (!result.ok) return result;
      return { action: input.action, ...result.data };
    }
    const result = await publishStrategyVersionTool.execute(
      {
        versionId: input.versionId as string,
        ...(input.strategyId === undefined ? {} : { strategyId: input.strategyId }),
      },
      ctx,
    );
    if (!result.ok) return result;
    return { action: input.action, ...result.data };
  },
});
