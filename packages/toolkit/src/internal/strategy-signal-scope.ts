import {
  isPublishableOperationalRun,
  isUsableStrategyRun,
  readStrategyRunSnapshot,
  type StrategySignal,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

export const StrategySignalScopeSchema = z.enum(['operational', 'evaluation']);
export type StrategySignalScope = z.infer<typeof StrategySignalScopeSchema>;

export const filterStrategySignalsByScope = async (
  signals: readonly StrategySignal[],
  ctx: ToolContext,
  input: {
    readonly scope: StrategySignalScope;
    readonly evaluationSessionId?: string;
  },
): Promise<StrategySignal[]> => {
  if (input.scope === 'evaluation' && input.evaluationSessionId === undefined) return [];
  const runs = await Promise.all(
    [...new Set(signals.map((signal) => signal.runId))].map(
      async (runId) => [runId, await ctx.repos.strategyRun.findRunById(runId)] as const,
    ),
  );
  const runById = new Map(runs);
  return signals.filter((signal) => {
    const run = runById.get(signal.runId);
    if (run === null || run === undefined) return false;
    if (input.scope === 'operational') return isPublishableOperationalRun(run);
    if (run.scope !== 'evaluation' || !isUsableStrategyRun(run)) return false;
    if (input.evaluationSessionId === undefined) return true;
    return (
      readStrategyRunSnapshot(run.inputSnapshot).evaluationSessionId === input.evaluationSessionId
    );
  });
};

export const readStrategySignalsByStock = async (
  ctx: ToolContext,
  input: {
    readonly stockId: string;
    readonly since?: Date;
    readonly scope: StrategySignalScope;
    readonly evaluationSessionId?: string;
  },
): Promise<StrategySignal[]> => {
  const signals = await ctx.repos.strategyRun.signalsByStock(input.stockId, input.since);
  return filterStrategySignalsByScope(signals, ctx, input);
};
