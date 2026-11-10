import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import {
  createStrictStrategyBacktestTool,
  executeStrictStrategyBacktestTool,
  getStrictStrategyBacktestTool,
  listStrictStrategyBacktestsTool,
} from './strategy-backtest.js';

const BacktestCostsInput = z.object({
  commissionRate: z.number().nonnegative().optional(),
  minCommission: z.number().nonnegative().optional(),
  stampDutyRate: z.number().nonnegative().optional(),
  slippageRate: z.number().nonnegative().optional(),
});

export const RunStrategyBacktestInput = z
  .object({
    action: z.enum(['run', 'execute', 'get', 'list']),
    backtestRunId: z.string().min(1).optional(),
    strategyId: z.string().min(1).optional(),
    strategyVersionId: z.string().min(1).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    initialCash: z.number().positive().optional(),
    benchmarkStockId: z.string().min(1).optional(),
    lotSize: z.number().int().positive().optional(),
    maxPositions: z.number().int().min(1).max(100).optional(),
    costs: BacktestCostsInput.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.action === 'execute' || input.action === 'get') {
      if (input.backtestRunId === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['backtestRunId'],
          message: `${input.action} 需要 backtestRunId`,
        });
      }
    }
    if (input.action === 'run') {
      for (const [field, value] of [
        ['strategyId', input.strategyId],
        ['strategyVersionId', input.strategyVersionId],
        ['from', input.from],
        ['to', input.to],
      ] as const) {
        if (value === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: `run 需要 ${field}`,
          });
        }
      }
    }
  });

export const RunStrategyBacktestOutput = z.record(z.string(), z.unknown());

export const runStrategyBacktestTool = defineTool({
  name: 'run_strategy_backtest',
  description:
    '策略历史区间回测：run 创建回测（策略版本 + from/to + 成本）并执行；execute 执行已创建回测；get/list 查询回测结果，返回收益、胜率、最大回撤等指标',
  sideEffect: 'write',
  input: RunStrategyBacktestInput,
  output: RunStrategyBacktestOutput,
  handler: async (input, ctx) => {
    if (input.action === 'run') {
      const created = await createStrictStrategyBacktestTool.execute(
        {
          strategyId: input.strategyId as string,
          strategyVersionId: input.strategyVersionId as string,
          from: input.from as Date,
          to: input.to as Date,
          ...(input.initialCash === undefined ? {} : { initialCash: input.initialCash }),
          ...(input.benchmarkStockId === undefined
            ? {}
            : { benchmarkStockId: input.benchmarkStockId }),
          ...(input.lotSize === undefined ? {} : { lotSize: input.lotSize }),
          ...(input.maxPositions === undefined ? {} : { maxPositions: input.maxPositions }),
          ...(input.costs === undefined ? {} : { costs: input.costs }),
        },
        ctx,
      );
      if (!created.ok) return created;
      const executed = await executeStrictStrategyBacktestTool.execute(
        { backtestRunId: created.data.run.id },
        ctx,
      );
      if (!executed.ok) return executed;
      return {
        action: 'run',
        backtestRunId: created.data.run.id,
        created: created.data.run,
        result: executed.data,
      };
    }
    if (input.action === 'execute') {
      const result = await executeStrictStrategyBacktestTool.execute(
        { backtestRunId: input.backtestRunId as string },
        ctx,
      );
      if (!result.ok) return result;
      return { action: 'execute', backtestRunId: input.backtestRunId, result: result.data };
    }
    if (input.action === 'get') {
      const result = await getStrictStrategyBacktestTool.execute(
        { backtestRunId: input.backtestRunId as string },
        ctx,
      );
      if (!result.ok) return result;
      return { action: 'get', ...result.data };
    }
    const result = await listStrictStrategyBacktestsTool.execute(
      {
        ...(input.strategyId === undefined ? {} : { strategyId: input.strategyId }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      ctx,
    );
    if (!result.ok) return result;
    return { action: 'list', ...result.data };
  },
});
