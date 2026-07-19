import type { TacticSignal, ToolResult } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

/**
 * tactic-scan（v0.3，plan-v0.2-v0.3 §3.5）：
 * list_tactics（默认全量）→ 并发跑每个战法生成 signals → score_signals 精排 → 输出 top N。
 */

export const TacticScanInput = z.object({
  tacticIds: z.array(z.string().min(1)).optional(),
  scope: z.enum(['holdings', 'watchlist', 'all-stocks']).default('holdings'),
  stockIds: z.array(z.string()).optional(),
  lookbackDays: z.number().int().positive().max(365).default(120),
  topN: z.number().int().positive().max(100).default(20),
});

export type TacticScanInputT = z.infer<typeof TacticScanInput>;

export const ScoredSignalSchema = z.object({
  tacticId: z.string(),
  tacticName: z.string(),
  tacticTag: z.string(),
  stockId: z.string(),
  ts: z.coerce.date(),
  score: z.number(),
  direction: z.string(),
  evidence: z.array(z.string()),
  llmScore: z.number(),
  rationale: z.string(),
});

export const TacticScanOutput = z.object({
  ranked: z.array(ScoredSignalSchema),
  totalTactics: z.number().int().nonnegative(),
  totalSignals: z.number().int().nonnegative(),
  evaluatedStocks: z.number().int().nonnegative(),
});

export type TacticScanOutputT = z.infer<typeof TacticScanOutput>;

interface RunState {
  readonly tacticIds: readonly string[];
  readonly input: TacticScanInputT;
}

interface ScoreState extends RunState {
  readonly signals: readonly TacticSignal[];
  readonly ranked: ReadonlyArray<z.infer<typeof ScoredSignalSchema>> | null;
  readonly evaluatedStocks: number;
}

const stepListTactics: WorkflowStep = async (prev, ctx) => {
  const input = prev as TacticScanInputT;
  const res = await ctx.tools.list_tactics.execute({ filter: undefined, includeBuiltins: true });
  if (!res.ok) return res as unknown as ToolResult<RunState>;
  const ids =
    input.tacticIds !== undefined && input.tacticIds.length > 0
      ? input.tacticIds
      : res.data.tactics.map((t) => t.id);
  return { tacticIds: ids, input } satisfies RunState;
};

const stepRunTactics: WorkflowStep = async (prev, ctx) => {
  const state = prev as RunState;
  const runs = await Promise.all(
    state.tacticIds.map((tacticId) =>
      ctx.tools.run_tactic.execute({
        tacticId,
        scope: state.input.scope,
        ...(state.input.stockIds !== undefined ? { stockIds: state.input.stockIds } : {}),
        lookbackDays: state.input.lookbackDays,
      }),
    ),
  );
  const okResults = runs.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
  const signals: TacticSignal[] = [];
  for (const r of okResults) {
    for (const s of r.data.signals) {
      const base: TacticSignal = {
        tacticId: s.tacticId,
        tacticName: s.tacticName,
        tacticTag: s.tacticTag,
        stockId: s.stockId,
        ts: s.ts,
        score: s.score,
        direction: s.direction,
        evidence: [...s.evidence],
      };
      signals.push(
        s.triggerSnapshot !== undefined
          ? Object.assign(base, { triggerSnapshot: s.triggerSnapshot })
          : base,
      );
    }
  }
  return { ...state, signals, ranked: null, evaluatedStocks: 0 } satisfies ScoreState;
};

const stepScoreSignals: WorkflowStep = async (prev, ctx) => {
  const state = prev as ScoreState;
  if (state.signals.length === 0) {
    return state;
  }
  const r = await ctx.tools.score_signals.execute({
    signals: state.signals.map((s) => ({
      tacticId: s.tacticId,
      tacticName: s.tacticName,
      tacticTag: s.tacticTag,
      stockId: s.stockId,
      ts: s.ts,
      score: s.score,
      direction: s.direction,
      evidence: [...s.evidence],
      ...(s.triggerSnapshot !== undefined ? { triggerSnapshot: s.triggerSnapshot } : {}),
    })),
  });
  if (!r.ok) return r as unknown as ToolResult<ScoreState>;
  const allStockIds = new Set(r.data.ranked.map((s) => s.stockId));
  return {
    ...state,
    ranked: r.data.ranked,
    evaluatedStocks: allStockIds.size,
  } satisfies ScoreState;
};

const stepFinalize: WorkflowStep = async (prev) => {
  const state = prev as ScoreState;
  const topN = state.input.topN;
  const ranked = state.ranked ?? [];
  return TacticScanOutput.parse({
    ranked: ranked.slice(0, topN),
    totalTactics: state.tacticIds.length,
    totalSignals: ranked.length,
    evaluatedStocks: state.evaluatedStocks,
  });
};

export const tacticScanWorkflow = defineWorkflow<TacticScanInputT, TacticScanOutputT>({
  name: 'tactic-scan',
  description: '扫所有战法 → 跑出 signals → LLM 精排 → 输出 top N',
  input: TacticScanInput,
  steps: [stepListTactics, stepRunTactics, stepScoreSignals, stepFinalize],
});
