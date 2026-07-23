import { AdviceSchema } from '@luoome/core';
import type { ListHoldingsOutput } from '@luoome/tools';
import { z } from 'zod';

import { defineWorkflow } from './define-workflow.js';

/** 高信心度阈值（AGENTS.md「Advice 输出的关键字段」：confidence ≥ 70 为高信心）。 */
export const HIGH_CONFIDENCE_THRESHOLD = 70;

export const DailyAdviceInput = z.object({
  /** 账户 id（uuid）；缺省为当前用户默认账户。 */
  accountId: z.uuid().optional(),
});
export type DailyAdviceInput = z.infer<typeof DailyAdviceInput>;

export const DailyAdviceSummary = z.object({
  /** 成功生成建议的条数（单票失败会被跳过，见 steps[1] 注释）。 */
  total: z.number().int().nonnegative(),
  /** 其中高信心度（confidence ≥ HIGH_CONFIDENCE_THRESHOLD）条数。 */
  highConfidence: z.number().int().nonnegative(),
});
export type DailyAdviceSummary = z.infer<typeof DailyAdviceSummary>;

export const DailyAdviceOutput = z.object({
  /** 每个活跃持仓一条 Advice，按 confidence 降序。 */
  advices: z.array(AdviceSchema),
  summary: DailyAdviceSummary,
});
export type DailyAdviceOutput = z.infer<typeof DailyAdviceOutput>;

/** list_holdings 的输出形状（步骤间类型在引擎层被擦除，步骤内做集中断言）。 */
type ListHoldingsResult = z.output<typeof ListHoldingsOutput>;

/** analyze_stock 输出的 Advice（zod 解析后形状，可变数组；区别于 core 的只读 Advice 接口）。 */
type AnalyzedAdvice = z.output<typeof AdviceSchema>;

/**
 * daily-advice（v0.1 骨架，ARCHITECTURE §8.1）：
 * list_holdings → 对每个持仓并发 analyze_stock（Promise.all）→ 汇总按信心度降序。
 *
 * 扩展点（本骨架刻意不接）：
 * - v0.2：analyze 前接 sync-quotes 刷新行情；analyze_stock 切真实 LLM；
 *   高信心度建议接 send_notification 推送（飞书等）。
 * - v0.3：接 run_tactic / score_signals 把战法信号织入建议上下文；
 *   单票失败从「warn + 跳过」升级为输出中的显式失败上报。
 * - advice.sourceWorkflow 标记需专用 persist 步骤回写（§4.6：workflow 不直连
 *   repos），待 v0.2 引入 persist tool 后补上。
 */
export const dailyAdviceWorkflow = defineWorkflow<DailyAdviceInput, DailyAdviceOutput>({
  name: 'daily-advice',
  description: '为账户全部活跃持仓生成当日建议，按信心度降序输出 advices + summary',
  input: DailyAdviceInput,
  steps: [
    // 1) 拉活跃持仓（含 PnL 汇总）；accountId 缺省走 ctx.user.defaultAccountId。
    //    返回 ToolResult：引擎自动解包；账户不存在（not_found）直接短路。
    (prev, ctx) => {
      const input = prev as DailyAdviceInput; // 首步 prev = 已通过 input schema 校验的工作流入参
      return ctx.tools.list_holdings.execute(
        input.accountId === undefined ? {} : { accountId: input.accountId },
      );
    },
    // 2) 对每个持仓并发 analyze_stock（Promise.all）。
    //    批量任务的单票失败不拖垮整批：logger.warn 记录后跳过（v0.3 再显式上报）。
    async (prev, ctx) => {
      const { holdings } = prev as ListHoldingsResult;
      const results = await Promise.all(
        holdings.map((h) => ctx.tools.analyze_stock.execute({ stockId: h.holding.stockId })),
      );
      const advices: AnalyzedAdvice[] = [];
      for (const [index, result] of results.entries()) {
        if (result.ok) {
          advices.push(result.data.advice);
        } else {
          ctx.logger.warn('daily-advice: analyze_stock 失败，跳过该持仓', {
            stockId: holdings[index]?.holding.stockId ?? 'unknown',
            errorKind: result.error.kind,
          });
        }
      }
      return advices;
    },
    // 3) 汇总：confidence 降序 + summary 计数；末步 schema parse 兜底输出形状。
    (prev) => {
      const advices = [...(prev as AnalyzedAdvice[])].sort((a, b) => b.confidence - a.confidence);
      return DailyAdviceOutput.parse({
        advices,
        summary: {
          total: advices.length,
          highConfidence: advices.filter((a) => a.confidence >= HIGH_CONFIDENCE_THRESHOLD).length,
        },
      });
    },
  ],
});
