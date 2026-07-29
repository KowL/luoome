import { randomUUID } from 'node:crypto';

import type {
  Report,
  ReportEvidence,
  ReportKind,
  ReportScope,
  ReportSection,
  ToolResult,
  WorkflowRunMode,
} from '@luoome/core';

import type { WorkflowContext } from '../define-workflow.js';

export interface ReportSectionPiece {
  readonly section: ReportSection;
  readonly evidence: readonly ReportEvidence[];
}

export interface ReportRunResult {
  readonly report: Report;
  readonly created: boolean;
  readonly workflowRunId: string;
  readonly notified: boolean;
}

interface ExecuteReportWorkflowInput {
  readonly workflowName: string;
  readonly kind: ReportKind;
  readonly template: string;
  readonly mode: WorkflowRunMode;
  readonly notify: boolean;
  readonly scope: ReportScope;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly title: string;
  readonly inputSummary?: Record<string, unknown>;
  readonly buildSections: (
    generatedAt: Date,
    ctx: WorkflowContext,
  ) => Promise<readonly ReportSectionPiece[]>;
}

export const executeReportWorkflow = async (
  input: ExecuteReportWorkflowInput,
  ctx: WorkflowContext,
): Promise<ReportRunResult | ToolResult<never>> => {
  const generatedAt = ctx.clock();
  const workflowRunId = `workflow-${input.kind}-${randomUUID()}`;
  const inputSummary = {
    scope: input.scope,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    template: input.template,
    ...input.inputSummary,
  };
  const running = await ctx.tools.record_workflow_run.execute({
    run: {
      id: workflowRunId,
      workflowName: input.workflowName,
      mode: input.mode,
      status: 'running',
      startedAt: generatedAt,
      inputSummary,
      providerStatuses: [],
    },
  });
  if (!running.ok) return running;

  let pieces: readonly ReportSectionPiece[];
  try {
    pieces = await input.buildSections(generatedAt, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.tools.record_workflow_run.execute({
      run: {
        id: workflowRunId,
        workflowName: input.workflowName,
        mode: input.mode,
        status: 'failed',
        startedAt: generatedAt,
        finishedAt: ctx.clock(),
        inputSummary,
        providerStatuses: [],
        error: message.slice(0, 500),
      },
    });
    return { ok: false, error: { kind: 'internal', cause: message } };
  }

  const sections = pieces.map((piece) => piece.section);
  const evidence = pieces.flatMap((piece) => piece.evidence);
  const missingDimensions = sections.flatMap((section) => section.missingDimensions);
  const requiredAsOf = sections
    .filter((section) => section.required && section.dataAsOf !== undefined)
    .map((section) => (section.dataAsOf as Date).getTime());
  const status = sections
    .filter((section) => section.required)
    .every((section) => section.status === 'complete')
    ? ('complete' as const)
    : ('partial' as const);
  const report: Report = {
    id: `report-${input.kind}-${randomUUID()}`,
    kind: input.kind,
    scope: input.scope,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    title: input.title,
    generatedAt,
    dataAsOf: requiredAsOf.length === 0 ? generatedAt : new Date(Math.min(...requiredAsOf)),
    status,
    sections,
    evidence: [...evidence],
    missingDimensions,
    deliveryStatus: 'not-requested',
    workflowRunId,
    createdAt: generatedAt,
    updatedAt: generatedAt,
  };
  const saved = await ctx.tools.save_report.execute({ report });
  if (!saved.ok) {
    await ctx.tools.record_workflow_run.execute({
      run: {
        id: workflowRunId,
        workflowName: input.workflowName,
        mode: input.mode,
        status: 'failed',
        startedAt: generatedAt,
        finishedAt: ctx.clock(),
        inputSummary,
        providerStatuses: [],
        error: `save_report: ${saved.error.kind}`,
      },
    });
    return saved;
  }

  let deliveredReport = saved.data.report;
  let notified = false;
  let notificationFailed = false;
  let notificationErrorKind: string | undefined;
  if (input.notify) {
    const pending = await ctx.tools.set_report_delivery_status.execute({
      reportId: deliveredReport.id,
      deliveryStatus: 'pending',
    });
    if (!pending.ok) {
      notificationFailed = true;
      notificationErrorKind = pending.error.kind;
    } else {
      deliveredReport = { ...deliveredReport, deliveryStatus: 'pending' };
      const rendered = await ctx.tools.render_report.execute({
        reportId: deliveredReport.id,
        format: 'markdown',
      });
      if (!rendered.ok) {
        notificationFailed = true;
        notificationErrorKind = rendered.error.kind;
      } else {
        const notification = await ctx.tools.send_notification.execute({
          channel: 'log',
          log: {
            title: deliveredReport.title,
            content: rendered.data.content.slice(0, 5000),
            level: deliveredReport.status === 'complete' ? 'success' : 'warn',
          },
        });
        if (!notification.ok || notification.data.notification.result === 'failed') {
          notificationFailed = true;
          notificationErrorKind = notification.ok ? 'delivery_failed' : notification.error.kind;
        } else {
          notified = true;
          const deliveryStatus =
            notification.data.notification.result === 'suppressed' ? 'fallback-log' : 'sent';
          const delivered = await ctx.tools.set_report_delivery_status.execute({
            reportId: deliveredReport.id,
            deliveryStatus,
          });
          if (!delivered.ok) {
            notificationFailed = true;
            notificationErrorKind = delivered.error.kind;
            notified = false;
          } else {
            deliveredReport = { ...deliveredReport, deliveryStatus };
          }
        }
      }
    }
    if (notificationFailed && deliveredReport.deliveryStatus === 'pending') {
      const failed = await ctx.tools.set_report_delivery_status.execute({
        reportId: deliveredReport.id,
        deliveryStatus: 'failed',
      });
      if (failed.ok) deliveredReport = { ...deliveredReport, deliveryStatus: 'failed' };
    }
  }

  const providerStatuses = evidence.map((item) => ({
    provider: item.provenance.provider,
    ok: item.provenance.freshness !== 'unavailable',
    ...(item.provenance.errorKind === undefined ? {} : { errorKind: item.provenance.errorKind }),
  }));
  if (input.notify) {
    providerStatuses.push({
      provider: 'notification',
      ok: !notificationFailed,
      ...(notificationErrorKind === undefined ? {} : { errorKind: notificationErrorKind }),
    });
  }
  const audited = await ctx.tools.record_workflow_run.execute({
    run: {
      id: workflowRunId,
      workflowName: input.workflowName,
      mode: input.mode,
      status:
        deliveredReport.status === 'complete' && !notificationFailed ? 'succeeded' : 'partial',
      startedAt: generatedAt,
      finishedAt: ctx.clock(),
      inputSummary,
      outputSummary: {
        reportId: saved.data.report.id,
        reportStatus: deliveredReport.status,
        missingDimensions: deliveredReport.missingDimensions.length,
        notified,
        deliveryStatus: deliveredReport.deliveryStatus,
      },
      providerStatuses,
    },
  });
  if (!audited.ok) return audited;
  return {
    report: deliveredReport,
    created: saved.data.created,
    workflowRunId,
    notified,
  };
};
