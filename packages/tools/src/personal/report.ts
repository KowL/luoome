import { randomUUID } from 'node:crypto';
import { quietHoursUntil, ReportDeliveryIntentSchema } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errLeaseLostBeforeCommit, errNotFound } from '../define-tool.js';
import { renderReportTool } from '../tools/render-report.js';
import { sendHostedFeishu } from './notification-delivery.js';

export const hostedReportExecutionTool = defineTool({
  name: 'hosted_report_execution',
  description: '报告批次租约、续租与失效投递恢复',
  sideEffect: 'write',
  input: z
    .object({ action: z.enum(['acquire', 'renew', 'release']), owner: z.string().min(1) })
    .strict(),
  output: z.object({ acquired: z.boolean() }),
  handler: async ({ action, owner }, ctx) => {
    const acquired = await ctx.repos.reportAutomation.execution(action, owner, ctx.clock());
    if (acquired && action === 'acquire')
      await ctx.repos.reportAutomation.recover(owner, ctx.clock());
    return { acquired };
  },
});
export const suppressHostedReportDeliveriesTool = defineTool({
  name: 'suppress_hosted_report_deliveries',
  description: '抑制失去服务权益的待发报告',
  sideEffect: 'write',
  input: z.object({}).strict(),
  output: z.object({ suppressed: z.number().int().nonnegative() }),
  handler: async (_input, ctx) => {
    return {
      suppressed: await ctx.repos.reportAutomation.suppressPending(
        'tenant-unavailable',
        ctx.clock(),
      ),
    };
  },
});
export const deliverHostedReportTool = defineTool({
  name: 'deliver_hosted_report',
  description: '按飞书绑定投递原报告，保留受理与未知事实',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  input: z.object({ reportId: z.string().min(1), owner: z.string().min(1) }).strict(),
  output: z.object({ intent: ReportDeliveryIntentSchema.nullable() }),
  handler: async ({ reportId, owner }, ctx) => {
    const report = await ctx.repos.report.findById(reportId);
    if (report === null) return errNotFound('Report', reportId);
    if (
      !(await ctx.repos.reportAutomation.prepare({
        reportId,
        owner,
        tenantId: ctx.user.id,
        generation: 1,
        now: ctx.clock(),
      }))
    )
      return { intent: null };
    const settings = await ctx.repos.watchDelivery.settings();
    if (quietHoursUntil(settings.quietHours, ctx.clock()) !== null) return { intent: null };
    const rendered = await renderReportTool.execute({ reportId, format: 'notification' }, ctx);
    if (!rendered.ok) return rendered;
    const attemptId = randomUUID();
    const intent = await ctx.repos.reportAutomation.claim(reportId, owner, attemptId, ctx.clock());
    if (intent === null) return { intent: null };
    if (settings.webhookUrl === null)
      ctx.logger.info('report notification fallback-log', { reportId });
    const delivered = await sendHostedFeishu(
      ctx,
      settings.webhookUrl,
      `report-notification:${reportId}:${intent.attempt}`,
      {
        title: report.title,
        content: rendered.data.content,
        level: report.status === 'complete' ? 'success' : 'warn',
      },
    );
    if (
      !(await ctx.repos.reportAutomation.complete({
        reportId,
        owner,
        attemptId,
        state: delivered.state,
        notificationId: delivered.notification.id,
        errorKind: delivered.errorKind,
        now: ctx.clock(),
      }))
    )
      return errLeaseLostBeforeCommit('报告投递租约已失效，结果待核对');
    return {
      intent:
        (await ctx.repos.reportAutomation.list()).find((entry) => entry.resultRef === reportId) ??
        null,
    };
  },
});
