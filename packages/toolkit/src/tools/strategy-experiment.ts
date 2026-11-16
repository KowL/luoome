import { STRATEGY_FIELD_REGISTRY, type StrategyFieldType } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

const STRATEGY_DSL_OPERATORS: Readonly<Record<StrategyFieldType, readonly string[]>> = {
  number: ['==', '!=', '===', '!==', '<', '<=', '>', '>=', '+', '-', '*', '/', '%'],
  boolean: ['==', '!=', '===', '!==', '&&', '||', '!'],
  string: ['==', '!=', '===', '!=='],
};

export const GetStrategyDslCatalogInput = z.object({
  schemaVersion: z.literal(1).default(1),
});

const StrategyDslCatalogFieldSchema = z.object({
  path: z.string().min(1),
  type: z.enum(['number', 'boolean', 'string']),
  unit: z.string().optional(),
  requiredLookback: z.number().int().nonnegative().optional(),
  dataSource: z.enum(['quote', 'daily-bars', 'meta', 'limit-up-ladder', 'limit-up-board-history']),
  coverage: z.array(z.literal('CN_A_SHARES_SH_SZ')),
  operators: z.array(z.string().min(1)),
});

export const GetStrategyDslCatalogOutput = z.object({
  schemaVersion: z.literal(1),
  fields: z.array(StrategyDslCatalogFieldSchema),
  limits: z.object({
    selectionRules: z.number().int().positive().nullable(),
    scoringComponents: z.number().int().positive().nullable(),
    signalRulesPerScope: z.number().int().positive().nullable(),
  }),
});
export type StrategyDslCatalog = z.infer<typeof GetStrategyDslCatalogOutput>;

export const getStrategyDslCatalogTool = defineTool({
  name: 'get_strategy_dsl_catalog',
  description:
    '读取 Strategy DSL 字段注册表与现有安全表达式运算符；只描述白名单，不执行表达式或修改策略',
  sideEffect: 'read',
  input: GetStrategyDslCatalogInput,
  output: GetStrategyDslCatalogOutput,
  handler: async () => ({
    schemaVersion: 1 as const,
    fields: STRATEGY_FIELD_REGISTRY.map((field) => ({
      path: field.path,
      type: field.type,
      ...(field.unit === undefined ? {} : { unit: field.unit }),
      ...(field.requiredLookback === undefined ? {} : { requiredLookback: field.requiredLookback }),
      dataSource: field.dataSource,
      coverage: [...field.availableForCoverage],
      operators: [...STRATEGY_DSL_OPERATORS[field.type]],
    })),
    limits: {
      selectionRules: null,
      scoringComponents: null,
      signalRulesPerScope: null,
    },
  }),
});
