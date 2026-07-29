import { z } from 'zod';
import { defineTool } from '../define-tool.js';

const Input = z.object({
  sourceKind: z.enum(['watch-trigger', 'tactic-signal']).optional(),
  horizon: z.enum(['t1', 't3', 't5', 't20']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const Output = z.object({
  sampleCount: z.number().int().nonnegative(),
  completeCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  unavailableCount: z.number().int().nonnegative(),
  missingRate: z.number().min(0).max(1),
  range: z.object({ from: z.coerce.date(), to: z.coerce.date() }).nullable(),
  averageReturnPct: z.number().nullable(),
  medianReturnPct: z.number().nullable(),
  benchmarkStatus: z.literal('unavailable'),
  backtest: z.object({ available: z.literal(false), reason: z.string() }),
});
export const getSignalObservationStatsTool = defineTool({
  name: 'get_signal_observation_stats',
  description: '读取信号后续事实样本统计；包含样本范围和缺失率，不提供回测曲线',
  sideEffect: 'read',
  input: Input,
  output: Output,
  handler: async (input, ctx) => {
    const all = await ctx.repos.signalObservation.list({
      ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
      limit: 10_000,
    });
    const rows =
      input.horizon === undefined ? all : all.filter((row) => row.horizon === input.horizon);
    const values = rows
      .flatMap((row) =>
        row.status === 'complete' && row.returnPct !== undefined ? [row.returnPct] : [],
      )
      .sort((a, b) => a - b);
    const dates = rows.flatMap((row) => (row.baselineAt === undefined ? [] : [row.baselineAt]));
    const medianIndex = Math.floor(values.length / 2);
    const median = values.length === 0 ? null : (values[medianIndex] ?? null);
    return {
      sampleCount: rows.length,
      completeCount: values.length,
      pendingCount: rows.filter((row) => row.status === 'pending').length,
      unavailableCount: rows.filter((row) => row.status === 'unavailable').length,
      missingRate: rows.length === 0 ? 0 : (rows.length - values.length) / rows.length,
      range:
        dates.length === 0
          ? null
          : {
              from: new Date(Math.min(...dates.map((d) => d.getTime()))),
              to: new Date(Math.max(...dates.map((d) => d.getTime()))),
            },
      averageReturnPct:
        values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length,
      medianReturnPct: median,
      benchmarkStatus: 'unavailable' as const,
      backtest: {
        available: false as const,
        reason: '复权、停牌、涨跌停、公司行为、费用和基准等口径尚未冻结',
      },
    };
  },
});
