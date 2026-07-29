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

export const TacticScanUniverseSchema = z.object({
  coverage: z.literal('CN_A_SHARES_SH_SZ'),
  observedAt: z.coerce.date().nullable(),
  activeStocks: z.number().int().positive(),
});

export const TacticScanOutput = z.object({
  ranked: z.array(ScoredSignalSchema),
  totalTactics: z.number().int().nonnegative(),
  totalSignals: z.number().int().nonnegative(),
  evaluatedStocks: z.number().int().nonnegative(),
  universe: TacticScanUniverseSchema.optional(),
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
  readonly universe?: z.infer<typeof TacticScanUniverseSchema>;
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
  if (okResults.length === 0) {
    const failure = runs.find((result) => !result.ok);
    if (failure !== undefined) return failure as ToolResult<ScoreState>;
  }
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
  const evaluatedStocks = Math.max(0, ...okResults.map((result) => result.data.evaluatedStocks));
  const universe = okResults.find((result) => result.data.universe !== undefined)?.data.universe;
  return {
    ...state,
    signals,
    ranked: null,
    evaluatedStocks,
    ...(universe === undefined ? {} : { universe }),
  } satisfies ScoreState;
};

const stepScoreSignals: WorkflowStep = async (prev, ctx) => {
  const state = prev as ScoreState;
  if (state.signals.length === 0) {
    return state;
  }
  const candidates = [...state.signals]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.stockId.localeCompare(b.stockId) ||
        a.tacticId.localeCompare(b.tacticId) ||
        a.ts.getTime() - b.ts.getTime(),
    )
    .slice(0, 50);
  const r = await ctx.tools.score_signals.execute({
    signals: candidates.map((s) => ({
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
  return {
    ...state,
    ranked: r.data.ranked,
  } satisfies ScoreState;
};

const stepFinalize: WorkflowStep = async (prev) => {
  const state = prev as ScoreState;
  const topN = state.input.topN;
  const ranked = state.ranked ?? [];
  return TacticScanOutput.parse({
    ranked: ranked.slice(0, topN),
    totalTactics: state.tacticIds.length,
    totalSignals: state.signals.length,
    evaluatedStocks: state.evaluatedStocks,
    ...(state.universe === undefined ? {} : { universe: state.universe }),
  });
};

export const tacticScanWorkflow = defineWorkflow<TacticScanInputT, TacticScanOutputT>({
  name: 'tactic-scan',
  description: '扫所有战法 → 跑出 signals → LLM 精排 → 输出 top N',
  input: TacticScanInput,
  steps: [stepListTactics, stepRunTactics, stepScoreSignals, stepFinalize],
});
