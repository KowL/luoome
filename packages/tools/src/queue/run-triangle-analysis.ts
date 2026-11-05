import { TriangleGateResultSchema, triangleDataHealthOf } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errAdapterError, errNotFound } from '../define-tool.js';
import { getMarketDataStatusTool } from '../tools/get-market-data-status.js';
import {
  DEFAULT_TRIANGLE_BUDGET,
  runTriangleAnalysis,
  TriangleEstimateSchema,
} from '../triangle-assembly.js';

const ModelRoute = z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict();
export const RunTriangleAnalysisInput = z
  .object({
    accountId: z.string().min(1).optional(),
    contextId: z.string().min(1),
    models: z
      .object({ bull: ModelRoute, bear: ModelRoute, judge: ModelRoute, 'risk-officer': ModelRoute })
      .strict(),
    estimate: TriangleEstimateSchema,
    confirmed: z.boolean(),
  })
  .strict();
export const RunTriangleAnalysisOutput = z.object({
  contextId: z.string(),
  factIds: z.array(z.string()),
  gate: TriangleGateResultSchema,
  roles: z.array(
    z.object({
      role: z.enum(['bull', 'bear', 'judge', 'risk-officer']),
      elapsedMs: z.number(),
      tokenUsed: z.number().nullable(),
      output: z.unknown(),
    }),
  ),
  blocked: z.object({ code: z.string(), message: z.string() }).nullable(),
  lead: z.string(),
  degraded: z.null(),
  tokenUsed: z.number().nullable(),
  elapsedMs: z.number(),
});
export const runTriangleAnalysisTool = defineTool({
  name: 'run_triangle_analysis',
  description:
    '显式确认预估成本后，以四个独立无工具模型请求分析同一事实快照；风险官否决会持久化且不自动生成建议。',
  sideEffect: 'external',
  requiredCapabilities: ['external', 'queue'],
  input: RunTriangleAnalysisInput,
  output: RunTriangleAnalysisOutput,
  handler: async (input, ctx) => {
    const runner = ctx.triangleRoleRunner;
    if (!runner) return errAdapterError('triangle-roles', '宿主未接入角色模型服务。', false);
    const context = await ctx.repos.analysis.findContext(
      input.accountId ?? ctx.user.defaultAccountId,
      input.contextId,
    );
    if (!context) return errNotFound('AnalysisContext', input.contextId);
    const status = await getMarketDataStatusTool.execute({}, ctx);
    if (!status.ok) return status;
    const signal = AbortSignal.any([
      ...(ctx.abortSignal ? [ctx.abortSignal] : []),
      AbortSignal.timeout(DEFAULT_TRIANGLE_BUDGET.maxDurationMs),
    ]);
    const dataHealth = triangleDataHealthOf({
      datasets: status.data.datasets.map((dataset) => ({
        state:
          dataset.freshness === 'fresh' ? 'ok' : dataset.freshness === 'stale' ? 'stale' : 'failed',
      })),
      watchlistStale: status.data.watchlistStale,
    });
    return runTriangleAnalysis({
      context,
      ctx,
      dataHealth,
      marketSession: status.data.marketSession,
      estimate: input.estimate,
      confirmed: input.confirmed,
      now: Date.now,
      executor: async (task, prior) => {
        const result = await runner({
          ...input.models[task.role],
          role: task.role,
          context: structuredClone(context),
          priorOutputs: prior.map((item) => item.output),
          signal,
        });
        return { ...(result.output as Record<string, unknown>), tokenUsed: result.tokenUsed };
      },
    });
  },
});
