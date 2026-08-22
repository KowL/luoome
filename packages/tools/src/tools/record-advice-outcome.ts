import { type Advice, type AdviceOutcome, AdviceOutcomeSchema, money } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

export const RecordAdviceOutcomeInput = z.object({
  adviceId: z.string().min(1),
  /** 执行结果；显式枚举避免 Web/TUI 将部分跟随误转为 ignored。 */
  outcome: z.enum(['followed', 'partially_followed', 'ignored']),
  /** 关联的成交记录；空数组表示未关联具体成交。 */
  tradeIds: z
    .array(z.string().min(1))
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, 'tradeIds 不可重复'),
  /** 实际盈亏（人民币）；尚未平仓或无法确认时保持缺省，不用 0 伪装已知。 */
  pnl: z.number().finite().optional(),
  /** 同期基准盈亏（可选；缺失时不参与基准比较）。 */
  benchmarkPnl: z.number().finite().optional(),
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
 * - 必填：adviceId + outcome
 * - 跟单：可填 tradeIds + pnl + holdingHours
 * - 盈亏未知：省略 pnl；0 只表示用户明确记录的零盈亏
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

    for (const tradeId of input.tradeIds) {
      const trade = await ctx.repos.trade.findById(tradeId);
      if (trade === null) return errNotFound('Trade', tradeId);
      if (trade.accountId !== ctx.user.defaultAccountId) {
        return errInvalidInput(`Trade ${tradeId} 不属于当前账户`);
      }
      if (advice.subjectKind === 'stock' && trade.stockId !== advice.subjectId) {
        return errInvalidInput(`Trade ${tradeId} 的标的与 Advice ${advice.id} 不一致`);
      }
    }

    const now = ctx.clock();
    const outcomeKind: AdviceOutcome['outcome'] = input.outcome;
    const outcome: AdviceOutcome = {
      adviceId: input.adviceId,
      tradeIds: input.tradeIds,
      outcome: outcomeKind,
      ...(input.pnl === undefined ? {} : { pnl: money(input.pnl) }),
      ...(input.benchmarkPnl === undefined ? {} : { benchmarkPnl: money(input.benchmarkPnl) }),
      ...(input.holdingHours === undefined ? {} : { holdingHours: input.holdingHours }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      recordedAt: now,
    };
    await ctx.repos.advice.recordOutcome(input.adviceId, outcome);
    return { outcome: AdviceOutcomeSchema.parse(outcome) };
  },
});
