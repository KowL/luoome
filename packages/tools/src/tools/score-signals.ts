import { TacticSignalSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

const SCORED_SIGNAL_SCHEMA = TacticSignalSchema.extend({
  /** LLM 精排后的 0-100 分。 */
  llmScore: z.number().min(0).max(100),
  /** 一句话解释（LLM 输出，便于审计）。 */
  rationale: z.string().min(1).max(500),
});

const ScoreSignalsInputSchema = z.object({
  signals: z.array(TacticSignalSchema).min(1).max(50),
  /** 选填：附加上下文（持仓 / 大盘 / 板块），供 LLM 精排时参考。 */
  context: z.string().max(2000).optional(),
});

const ScoreSignalsOutputSchema = z.object({
  ranked: z.array(SCORED_SIGNAL_SCHEMA),
});

export const ScoreSignalsInput = ScoreSignalsInputSchema;
export const ScoreSignalsOutput = ScoreSignalsOutputSchema;

const SCORE_SIGNALS_SYSTEM =
  'score_signals\n' +
  '你是战法信号精排助手。给定一组战法原始 signals（包含 score / direction / evidence），' +
  '请结合持仓上下文（context 字段）对每个 signal 输出 0-100 的 llmScore 与一句话 rationale。' +
  '要求：llmScore 与原 score 同方向但允许 ±20 修正；rationale 中文 ≤ 80 字；只输出 JSON 数组。';

/**
 * 战法信号精排（v0.3 起，read）。
 * 调用 LLM 把 run_tactic 的原始 signal 做最终排序，给出 llmScore + rationale。
 *
 * v0.3 mock 实现：保留 LLM 调用结构，但 mock adapter 按确定性 fallback 返回；
 * 真实 LLM 接入由 manager 决定（v0.2 已支持 OpenAI 兼容 + Anthropic）。
 */
export const scoreSignalsTool = defineTool({
  name: 'score_signals',
  description:
    '对一组战法 signals 做 LLM 精排（输出 llmScore + rationale），用于 list_tactics + run_tactic 后筛选',
  sideEffect: 'read',
  input: ScoreSignalsInput,
  output: ScoreSignalsOutput,
  handler: async (input, ctx) => {
    const ranked = await ctx.adapters.llm.generate<
      Array<{ tacticId: string; stockId: string; ts: string; llmScore: number; rationale: string }>
    >({
      system: SCORE_SIGNALS_SYSTEM,
      schema: z.array(
        z.object({
          tacticId: z.string(),
          stockId: z.string(),
          ts: z.string(),
          llmScore: z.number().min(0).max(100),
          rationale: z.string().min(1).max(500),
        }),
      ),
      data: {
        signals: input.signals.map((s) => ({
          tacticId: s.tacticId,
          tacticName: s.tacticName,
          tacticTag: s.tacticTag,
          stockId: s.stockId,
          ts: s.ts.toISOString(),
          score: s.score,
          direction: s.direction,
          evidence: s.evidence,
        })),
        ...(input.context !== undefined ? { context: input.context } : {}),
      },
    });
    // 拼回 TacticSignal + llmScore + rationale（按 (tacticId, stockId, ts) 匹配）
    const key = (tacticId: string, stockId: string, ts: string): string =>
      `${tacticId}|${stockId}|${ts}`;
    const llmMap = new Map(ranked.map((r) => [key(r.tacticId, r.stockId, r.ts), r]));
    const out = input.signals
      .map((s) => {
        const r = llmMap.get(key(s.tacticId, s.stockId, s.ts.toISOString()));
        const llmScore = r?.llmScore ?? s.score;
        const rationale = r?.rationale ?? 'mock: 与原 score 一致';
        return SCORED_SIGNAL_SCHEMA.parse({ ...s, llmScore, rationale });
      })
      .sort((a, b) => b.llmScore - a.llmScore);
    return { ranked: out };
  },
});
