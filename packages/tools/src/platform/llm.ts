import {
  type HostedLLMCostRow,
  HostedLLMTokensSchema,
  ProviderAttemptSchema,
  UsageReservationSchema,
} from '@luoome/core';
import { z } from 'zod';
import { definePlatformTool } from './define-platform-tool.js';

const Count = z.number().int().nonnegative().safe();
export const getHostedLLMCostsTool = definePlatformTool({
  name: 'get_hosted_llm_costs',
  description: '读取实际 provider usage 的每租户成本分布；未知成本不冒充零，不读取投资正文',
  sideEffect: 'read',
  actors: ['worker', 'admin'],
  input: z
    .object({ since: z.coerce.date().optional(), until: z.coerce.date().optional() })
    .strict()
    .refine(
      (input) => !input.since || !input.until || input.since <= input.until,
      'invalid cost window',
    ),
  output: z.object({
    currency: z.literal('CNY'),
    sampleTenants: Count,
    completeTenants: Count,
    status: z.enum(['unavailable', 'partial', 'complete']),
    window: z.object({ since: z.coerce.date().nullable(), until: z.coerce.date().nullable() }),
    p50CostMicro: Count.nullable(),
    p95CostMicro: Count.nullable(),
    tenants: z.array(
      z.object({
        tenantId: z.string(),
        confirmedMicro: Count,
        reservedMicro: Count,
        unknownAttempts: Count,
        confirmedAttempts: Count,
        inputTokens: Count,
        cachedInputTokens: Count,
        outputTokens: Count,
        totalCostMicro: Count.nullable(),
      }),
    ),
  }),
  handler: async (input, ctx) => {
    const rows = await ctx.repos.llm.costs({
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
    });
    const complete = rows
      .filter((row) => row.unknownAttempts === 0)
      .map((row) => row.confirmedMicro)
      .sort((a, b) => a - b);
    const percentile = (p: number) =>
      complete.length === 0 ? null : complete[Math.max(0, Math.ceil(complete.length * p) - 1)]!;
    return {
      currency: 'CNY' as const,
      window: { since: input.since ?? null, until: input.until ?? null },
      sampleTenants: rows.length,
      completeTenants: complete.length,
      status:
        rows.length === 0
          ? ('unavailable' as const)
          : complete.length === rows.length
            ? ('complete' as const)
            : ('partial' as const),
      p50CostMicro: percentile(0.5),
      p95CostMicro: percentile(0.95),
      tenants: rows.map((row: HostedLLMCostRow) => ({
        ...row,
        totalCostMicro: row.unknownAttempts > 0 ? null : row.confirmedMicro,
      })),
    };
  },
});
export const reconcileHostedLLMUsageTool = definePlatformTool({
  name: 'reconcile_hosted_llm_usage',
  description: '运维以供应商可信 usage 回执核对 unknown 成本；不释放仍在运行的预占',
  sideEffect: 'write',
  actors: ['admin', 'worker'],
  input: z
    .object({
      operationId: z.string().min(1),
      attemptId: z.string().min(1),
      tokens: HostedLLMTokensSchema,
      receiptId: z.string().min(1).max(256),
      executionStopped: z.literal(true),
      settlement: z.enum(['capture', 'release']).optional(),
    })
    .strict(),
  output: z.object({
    attempt: ProviderAttemptSchema,
    reservation: UsageReservationSchema.nullable(),
  }),
  handler: async (input, ctx) => {
    const attempt = await ctx.repos.llm.complete({
      operationId: input.operationId,
      id: input.attemptId,
      tokens: input.tokens,
      receiptId: input.receiptId,
      now: ctx.clock(),
    });
    const reservation =
      input.settlement === undefined
        ? await ctx.repos.llm.find(input.operationId)
        : await ctx.repos.llm.settle({
            operationId: input.operationId,
            capture: input.settlement === 'capture',
            now: ctx.clock(),
            executionStopped: true,
          });
    return { attempt, reservation };
  },
});
export const platformLLMTools = [getHostedLLMCostsTool, reconcileHostedLLMUsageTool] as const;
