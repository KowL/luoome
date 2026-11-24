import {
  type GenerateStockBriefsInput,
  GenerateStockBriefsInput as GenerateStockBriefsInputSchema,
  GenerateStockBriefsOutput as GenerateStockBriefsOutputSchema,
} from '@luoome/tools';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext } from './define-workflow.js';

/**
 * daily-stock-briefs（design.md §6 / §9）：每日个股观察的唯一生成入口。
 *
 * 编排本身只经 `ctx.tools.*`：候选集 / 预筛 / LLM / 校验 / 落库都在
 * `generate_stock_briefs` 内完成，本 workflow 负责审计与汇总
 * （`workflow_runs.output_summary` 带 coverage / budget）。
 * 17:30 调度合并属 P1-10，本次不改现有调度。
 */

export const DAILY_STOCK_BRIEFS_WORKFLOW_NAME = 'daily-stock-briefs';

export const DailyStockBriefsInput = GenerateStockBriefsInputSchema.extend({
  /** 运行来源；调度器接入时传 scheduled。 */
  mode: z.enum(['manual', 'scheduled', 'daemon']).default('manual'),
});
export type DailyStockBriefsInput = z.infer<typeof DailyStockBriefsInput>;

export const DailyStockBriefsOutput = z.object({
  briefs: GenerateStockBriefsOutputSchema,
  coverage: GenerateStockBriefsOutputSchema.shape.coverage,
  budget: GenerateStockBriefsOutputSchema.shape.budget,
  workflowRunId: z.string().min(1),
});
export type DailyStockBriefsOutput = z.infer<typeof DailyStockBriefsOutput>;

interface BriefsStepState {
  readonly workflowRunId: string;
  readonly input: GenerateStockBriefsInput;
  readonly mode: DailyStockBriefsInput['mode'];
  readonly startedAt: Date;
}

export const dailyStockBriefsWorkflow = defineWorkflow<
  DailyStockBriefsInput,
  DailyStockBriefsOutput
>({
  name: DAILY_STOCK_BRIEFS_WORKFLOW_NAME,
  description:
    '盘后每日个股观察批量：候选集 → 事实包 → 规则预筛 → AI 技术研究（并发 2、预算内）→ 落库并汇总 coverage/budget；' +
    '仅技术研究，不构成投资建议',
  input: DailyStockBriefsInput,
  steps: [
    // 1) 先落 running 审计行，保证超时/中断也能在 workflow_runs 里看到。
    async (prev, ctx: WorkflowContext): Promise<BriefsStepState> => {
      const { mode, ...input } = prev as DailyStockBriefsInput;
      const startedAt = ctx.clock();
      const workflowRunId = `workflow-${DAILY_STOCK_BRIEFS_WORKFLOW_NAME}-${globalThis.crypto.randomUUID()}`;
      const recorded = await ctx.tools.record_workflow_run.execute({
        run: {
          id: workflowRunId,
          workflowName: DAILY_STOCK_BRIEFS_WORKFLOW_NAME,
          mode,
          status: 'running',
          startedAt,
          inputSummary: {
            scope: input.scope,
            phase: input.phase,
            ...(input.tradingDate === undefined ? {} : { tradingDate: input.tradingDate }),
            ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
          },
          providerStatuses: [],
        },
      });
      if (!recorded.ok) throw new Error(`record_workflow_run: ${recorded.error.kind}`);
      return { workflowRunId, input, mode, startedAt };
    },
    // 2) 生成批次（唯一入口；插件未启用会返回 permission_denied 而不是静默跳过）。
    async (prev, ctx: WorkflowContext) => {
      const state = prev as BriefsStepState;
      const result = await ctx.tools.generate_stock_briefs.execute(state.input);
      const finishedAt = ctx.clock();
      if (!result.ok) {
        await ctx.tools.record_workflow_run.execute({
          run: {
            id: state.workflowRunId,
            workflowName: DAILY_STOCK_BRIEFS_WORKFLOW_NAME,
            mode: state.mode,
            status: 'failed',
            startedAt: state.startedAt,
            finishedAt,
            providerStatuses: [],
            error: result.error.kind.slice(0, 500),
          },
        });
        return result;
      }
      const data = result.data;
      await ctx.tools.record_workflow_run.execute({
        run: {
          id: state.workflowRunId,
          workflowName: DAILY_STOCK_BRIEFS_WORKFLOW_NAME,
          mode: state.mode,
          status: data.summary.degraded ? 'partial' : 'succeeded',
          startedAt: state.startedAt,
          finishedAt,
          outputSummary: {
            coverage: data.coverage,
            budget: data.budget,
            llmHttpCalls: data.summary.llmHttpCalls,
            tokens: data.summary.tokens,
            llmBriefs: data.summary.llmBriefs,
            ruleOnlyBriefs: data.summary.ruleOnlyBriefs,
            unavailableBriefs: data.summary.unavailableBriefs,
            skippedByDigest: data.summary.skippedByDigest,
            ...(data.degradation === undefined ? {} : { degradation: data.degradation.reason }),
          },
          providerStatuses: [],
        },
      });
      return {
        briefs: data,
        coverage: data.coverage,
        budget: data.budget,
        workflowRunId: state.workflowRunId,
      } satisfies DailyStockBriefsOutput;
    },
  ],
});
