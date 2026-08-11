import { createHash } from 'node:crypto';
import {
  StrategyEvaluationDaySchema,
  StrategyEvaluationSessionSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

export const GetStrategyPitUniverseInput = z.object({ asOf: z.coerce.date() });
export const GetStrategyPitUniverseOutput = z.object({
  syncId: z.string(),
  observedAt: z.coerce.date(),
  stockIds: z.array(z.string()),
  memberChecksum: z.string(),
});

export const getStrategyPitUniverseTool = defineTool({
  name: 'get_strategy_pit_universe',
  description: '读取不晚于指定时点的成功 StockUniverse snapshot，供 PIT replay 固定股票池',
  sideEffect: 'read',
  input: GetStrategyPitUniverseInput,
  output: GetStrategyPitUniverseOutput,
  handler: async (input, ctx: ToolContext) => {
    const sync = await ctx.repos.stockUniverse.latestSnapshotAtOrBefore({
      coverage: 'CN_A_SHARES_SH_SZ',
      asOf: input.asOf,
    });
    if (sync === null || sync.observedAt === null)
      return errNotFound('StockUniverseSnapshot', input.asOf.toISOString());
    const stockIds = (await ctx.repos.stockUniverse.listSnapshotMembers(sync.id))
      .map((stock) => stock.id)
      .sort();
    return {
      syncId: sync.id,
      observedAt: sync.observedAt,
      stockIds,
      memberChecksum: createHash('sha256').update(JSON.stringify(stockIds)).digest('hex'),
    };
  },
});

export const StartStrategyEvaluationSessionInput = z.object({
  strategyId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  stockIds: z.array(z.string().min(1)).min(1).max(500).optional(),
});
export const StartStrategyEvaluationSessionOutput = z.object({
  session: StrategyEvaluationSessionSchema,
});

export const GetStrategyEvaluationSessionInput = z.object({ sessionId: z.string().min(1) });
export const GetStrategyEvaluationSessionOutput = z.object({
  session: StrategyEvaluationSessionSchema.nullable(),
});
export const getStrategyEvaluationSessionTool = defineTool({
  name: 'get_strategy_evaluation_session',
  description: '读取历史评估 session 状态，供断点续跑与审计',
  sideEffect: 'read',
  input: GetStrategyEvaluationSessionInput,
  output: GetStrategyEvaluationSessionOutput,
  handler: async (input, ctx) => ({
    session: await ctx.repos.strategyEvaluation.findSessionById(input.sessionId),
  }),
});

export const startStrategyEvaluationSessionTool = defineTool({
  name: 'start_strategy_evaluation_session',
  description: '创建可续跑的 Strategy 历史评估 session；不发布 operational current',
  sideEffect: 'write',
  input: StartStrategyEvaluationSessionInput,
  output: StartStrategyEvaluationSessionOutput,
  handler: async (input, ctx: ToolContext) => {
    if (input.from > input.to) return errInvalidInput('evaluation from 不能晚于 to');
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    const versionId = input.versionId ?? strategy.currentVersionId;
    if (versionId === undefined) return errInvalidInput('Strategy 缺少 currentVersionId');
    const version = await ctx.repos.strategy.findVersionById(versionId);
    if (version === null) return errNotFound('StrategyVersion', versionId);
    if (version.strategyId !== input.strategyId || version.validationStatus !== 'valid') {
      return errInvalidInput('evaluation 只能使用同一 Strategy 的 valid version');
    }
    const stockIds = input.stockIds === undefined ? undefined : [...new Set(input.stockIds)].sort();
    const session = StrategyEvaluationSessionSchema.parse({
      id: `strategy-evaluation-${globalThis.crypto.randomUUID()}`,
      strategyId: input.strategyId,
      strategyVersionId: version.id,
      from: input.from,
      to: input.to,
      status: 'running',
      definitionHash: version.definitionHash,
      createdAt: ctx.clock(),
      ...(stockIds === undefined
        ? {}
        : {
            stockIds,
            stockIdChecksum: createHash('sha256').update(JSON.stringify(stockIds)).digest('hex'),
          }),
    });
    await ctx.repos.strategyEvaluation.saveSession(session);
    return { session };
  },
});

export const RecordStrategyEvaluationDayInput = StrategyEvaluationDaySchema;
export const RecordStrategyEvaluationDayOutput = z.object({ day: StrategyEvaluationDaySchema });
export const recordStrategyEvaluationDayTool = defineTool({
  name: 'record_strategy_evaluation_day',
  description: '记录 range replay 单日运行与 checkpoint，支持断点续跑',
  sideEffect: 'write',
  input: RecordStrategyEvaluationDayInput,
  output: RecordStrategyEvaluationDayOutput,
  handler: async (input, ctx: ToolContext) => {
    await ctx.repos.strategyEvaluation.saveDay(input);
    return { day: input };
  },
});

export const ListStrategyEvaluationDaysInput = z.object({ sessionId: z.string().min(1) });
export const ListStrategyEvaluationDaysOutput = z.object({
  days: z.array(StrategyEvaluationDaySchema),
});
export const listStrategyEvaluationDaysTool = defineTool({
  name: 'list_strategy_evaluation_days',
  description: '列出历史评估 session 的逐日状态，支持跳过已完成日期',
  sideEffect: 'read',
  input: ListStrategyEvaluationDaysInput,
  output: ListStrategyEvaluationDaysOutput,
  handler: async (input, ctx) => ({
    days: await ctx.repos.strategyEvaluation.listDays(input.sessionId),
  }),
});

export const FinishStrategyEvaluationSessionInput = z.object({
  sessionId: z.string().min(1),
  status: z.enum(['complete', 'partial', 'failed']),
  error: z.string().min(1).optional(),
});
export const FinishStrategyEvaluationSessionOutput = z.object({
  session: StrategyEvaluationSessionSchema,
});
export const finishStrategyEvaluationSessionTool = defineTool({
  name: 'finish_strategy_evaluation_session',
  description: '结束历史评估 session 并保留状态与错误原因',
  sideEffect: 'write',
  input: FinishStrategyEvaluationSessionInput,
  output: FinishStrategyEvaluationSessionOutput,
  handler: async (input, ctx: ToolContext) => {
    const existing = await ctx.repos.strategyEvaluation.findSessionById(input.sessionId);
    if (existing === null) return errNotFound('StrategyEvaluationSession', input.sessionId);
    const session = StrategyEvaluationSessionSchema.parse({
      ...existing,
      status: input.status,
      finishedAt: ctx.clock(),
      ...(input.error === undefined ? {} : { error: input.error }),
    });
    await ctx.repos.strategyEvaluation.saveSession(session);
    return { session };
  },
});
