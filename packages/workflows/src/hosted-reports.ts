import { randomUUID } from 'node:crypto';
import {
  dateInShanghai,
  isHoliday,
  isWeekend,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';
import { closingReportWorkflow } from './closing-report.js';
import { buildWorkflowTools, defineWorkflow } from './define-workflow.js';
import { openingReportWorkflow } from './opening-report.js';

export const HostedReportsInput = z.object({}).strict();
export const HostedReportsOutput = z.object({
  created: z.array(z.string()),
  accepted: z.array(z.string()),
  waiting: z.array(z.enum(['opening', 'closing'])),
  acquired: z.boolean(),
});

export const hostedReportsWorkflow = defineWorkflow<
  z.infer<typeof HostedReportsInput>,
  z.infer<typeof HostedReportsOutput>
>({
  name: 'hosted-reports',
  description: '按租户生成不可变的开盘简报和收盘复盘，并有限重试原报告投递',
  input: HostedReportsInput,
  steps: [
    async (_input, ctx) => {
      const owner = randomUUID();
      const execution = ctx.tools.hosted_report_execution;
      const acquired = await execution.execute({ action: 'acquire', owner });
      if (!acquired.ok) return acquired;
      const output = {
        created: [] as string[],
        accepted: [] as string[],
        waiting: [] as Array<'opening' | 'closing'>,
        acquired: acquired.data.acquired,
      };
      if (!acquired.data.acquired) return output;
      let lost = false;
      const renew = async (): Promise<boolean> => {
        if (lost) return false;
        const result = await execution.execute({ action: 'renew', owner });
        lost = !result.ok || !result.data.acquired;
        return !lost;
      };
      const timer = setInterval(() => void renew(), 30_000);
      const guarded: ToolContext = {
        ...ctx,
        reportExecutionOwner: owner,
        hostedAuthorization: async (
          name,
          input,
          capabilities,
        ): Promise<ToolResult<never> | null> => {
          if (!(await renew()))
            return { ok: false, error: { kind: 'internal', cause: '报告执行租约已失效' } };
          return (await ctx.hostedAuthorization?.(name, input, capabilities)) ?? null;
        },
      };
      const tools = buildWorkflowTools(guarded);
      try {
        const now = ctx.clock();
        const date = dateInShanghai(now);
        if (isWeekend(now) || isHoliday(now)) return output;
        const scope = { kind: 'account' as const, accountId: ctx.user.defaultAccountId };
        for (const kind of ['opening', 'closing'] as const) {
          const dueAt = new Date(`${date}T${kind === 'opening' ? '08:50' : '16:30'}:00+08:00`);
          if (ctx.clock() < dueAt) continue;
          const existing = await tools.get_report.execute({
            kind,
            scope,
            periodEnd: date,
            version: 1,
          });
          if (!existing.ok && existing.error.kind !== 'not_found') return existing;
          let report = existing.ok ? existing.data.report : null;
          if (report === null) {
            const generated = await (kind === 'opening'
              ? openingReportWorkflow
              : closingReportWorkflow
            ).run({ date, scope, mode: 'scheduled', notify: false }, guarded);
            if (!generated.ok) {
              if (kind === 'closing' && generated.error.kind === 'invalid_input') {
                output.waiting.push(kind);
                continue;
              }
              return generated;
            }
            report = generated.data.report;
            if (generated.data.created) output.created.push(report.id);
          }
          const delivery = await tools.deliver_hosted_report.execute({
            reportId: report.id,
            owner,
          });
          if (!delivery.ok) return delivery;
          if (delivery.data.intent?.state === 'accepted') output.accepted.push(report.id);
        }
        return HostedReportsOutput.parse(output);
      } finally {
        clearInterval(timer);
        await execution.execute({ action: 'release', owner });
      }
    },
  ],
});
