import {
  type Advice,
  type AdviceOutcome,
  AdviceOutcomeSchema,
  type Money,
  money,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const RecordAdviceOutcomeInput = z.object({
  adviceId: z.string().min(1),
  /** 是否跟单。 */
  followed: z.boolean(),
  /** 实际盈亏（人民币，跟单平仓时统计；不跟单时给 0）。 */
  pnl: z.number().finite().default(0),
  /** 跟单持仓时长（小时；用于统计持仓周期胜率）。 */
  holdingHours: z.number().nonnegative().optional(),
  /** 备注 / 复盘笔记。 */
  notes: z.string().max(2000).optional(),
});

export const RecordAdviceOutcomeOutput = z.object({
  outcome: AdviceOutcomeSchema,
});

/**
 * 记录建议结果（v0.3 起，write）。
 * - 必填：adviceId + followed
 * - 跟单：填 pnl + holdingHours
 * - 不跟单：followed=false，pnl=0
 *
 * 注意：本 tool 是 write 副作用；MCP 默认不暴露（opt-in）。
 */
export const recordAdviceOutcomeTool = defineTool({
  name: 'record_advice_outcome',
  description: '回填 Advice 的实际结果（跟单/盈亏/复盘笔记），用于准确率统计',
  sideEffect: 'write',
  input: RecordAdviceOutcomeInput,
  output: RecordAdviceOutcomeOutput,
  handler: async (input, ctx) => {
    const advice: Advice | null = await ctx.repos.advice.findById(input.adviceId);
    if (advice === null) return errNotFound('Advice', input.adviceId);

    const now = ctx.clock();
    const outcomeKind: AdviceOutcome['outcome'] = input.followed ? 'followed' : 'ignored';
    const pnlMoney: Money = money(input.pnl);
    const outcome: AdviceOutcome = {
      adviceId: input.adviceId,
      outcome: outcomeKind,
      pnl: pnlMoney,
      recordedAt: now,
    };
    await ctx.repos.advice.recordOutcome(input.adviceId, outcome);
    return { outcome: AdviceOutcomeSchema.parse(outcome) };
  },
});
