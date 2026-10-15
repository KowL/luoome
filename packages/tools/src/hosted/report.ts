import { randomUUID } from 'node:crypto';
import { hostedQuietUntil, ReportDeliveryIntentSchema, type ToolResult } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errLeaseLostBeforeCommit, errNotFound } from '../define-tool.js';
import { renderReportTool } from '../tools/render-report.js';
import { sendHostedFeishu } from './notification-delivery.js';

const workerDenied = (): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required: 'hosted:worker' },
});
export const hostedReportExecutionTool = defineTool({
  name: 'hosted_report_execution',
  description: 'worker-only：报告批次租约、续租与失效投递恢复',
  sideEffect: 'write',
  input: z
    .object({ action: z.enum(['acquire', 'renew', 'release']), owner: z.string().min(1) })
    .strict(),
  output: z.object({ acquired: z.boolean() }),
  handler: async ({ action, owner }, ctx) => {
    if (ctx.identity?.mode !== 'hosted' || ctx.identity.actor !== 'worker') return workerDenied();
    const acquired = await ctx.repos.reportAutomation.execution(action, owner, ctx.clock());
    if (acquired && action === 'acquire')
      await ctx.repos.reportAutomation.recover(owner, ctx.clock());
    return { acquired };
  },
});
export const suppressHostedReportDeliveriesTool = defineTool({
  name: 'suppress_hosted_report_deliveries',
  description: 'worker-only：抑制失去服务权益的待发报告',
  sideEffect: 'write',
  input: z.object({}).strict(),
  output: z.object({ suppressed: z.number().int().nonnegative() }),
  handler: async (_input, ctx) => {
    if (ctx.identity?.mode !== 'hosted' || ctx.identity.actor !== 'worker') return workerDenied();
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
  description: 'worker-only：按租户飞书绑定投递原报告，保留受理与未知事实',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  input: z.object({ reportId: z.string().min(1), owner: z.string().min(1) }).strict(),
  output: z.object({ intent: ReportDeliveryIntentSchema.nullable() }),
  handler: async ({ reportId, owner }, ctx) => {
    if (ctx.identity?.mode !== 'hosted' || ctx.identity.actor !== 'worker') return workerDenied();
    const report = await ctx.repos.report.findById(reportId);
    if (report === null) return errNotFound('Report', reportId);
    if (
      !(await ctx.repos.reportAutomation.prepare({
        reportId,
        owner,
        tenantId: ctx.identity.tenantId,
        generation: ctx.identity.tenantGeneration,
        now: ctx.clock(),
      }))
    )
      return { intent: null };
    const settings = await ctx.repos.watchDelivery.settings();
    if (hostedQuietUntil(settings.quietHours, ctx.clock()) !== null) return { intent: null };
    const rendered = await renderReportTool.execute({ reportId, format: 'notification' }, ctx);
    if (!rendered.ok) return rendered;
    // 渲染可能跨过订阅截止点；在外发领取前重新检查服务权益。
    const denied = await ctx.hostedAuthorization?.('deliver_hosted_report', { reportId, owner }, [
      'write',
      'external',
    ]);
    if (denied) {
      await ctx.repos.reportAutomation.suppressPending('tenant-unavailable', ctx.clock());
      return denied;
    }
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
