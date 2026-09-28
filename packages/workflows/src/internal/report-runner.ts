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
  readonly supplement?: boolean;
  readonly shouldNotifySupplement?: (previous: Report, next: Report) => boolean;
  readonly inputSummary?: Record<string, unknown>;
  readonly buildSections: (
    generatedAt: Date,
    ctx: WorkflowContext,
  ) => Promise<readonly ReportSectionPiece[]>;
}

const deliverClaimedReport = async (
  report: Report,
  attemptId: string,
  ctx: WorkflowContext,
): Promise<{
  readonly report: Report;
  readonly notified: boolean;
  readonly failed: boolean;
  readonly errorKind?: string;
}> => {
  let status: 'sent' | 'fallback-log' | 'failed' = 'failed';
  let errorKind: string | undefined;
  const rendered = await ctx.tools.render_report.execute({
    reportId: report.id,
    format: 'notification',
  });
  if (!rendered.ok) {
    errorKind = rendered.error.kind;
  } else {
    const sent = await ctx.tools.send_notification.execute({
      ...(report.kind === 'closing' ? { notificationId: `report-notification:${report.id}` } : {}),
      channel: 'feishu',
      feishu: {
        title: report.title,
        content: rendered.data.content,
        level: report.status === 'complete' ? 'success' : 'warn',
      },
    });
    if (!sent.ok || sent.data.notification.result === 'failed') {
      errorKind = sent.ok ? 'delivery_failed' : sent.error.kind;
    } else {
      status = sent.data.notification.result === 'suppressed' ? 'fallback-log' : 'sent';
    }
  }
  const finished = await ctx.tools.set_report_delivery_status.execute({
    reportId: report.id,
    deliveryStatus: status,
    attemptId,
  });
  if (!finished.ok) errorKind = finished.error.kind;
  const current = await ctx.tools.get_report.execute({ id: report.id });
  if (!current.ok) errorKind = current.error.kind;
  return {
    report: current.ok ? current.data.report : report,
    notified: status === 'sent' && finished.ok && current.ok,
    failed: status === 'failed' || !finished.ok || !current.ok,
    ...(errorKind === undefined ? {} : { errorKind }),
  };
};

export const executeReportWorkflow = async (
  input: ExecuteReportWorkflowInput,
  ctx: WorkflowContext,
): Promise<ReportRunResult | ToolResult<never>> => {
  const generatedAt = ctx.clock();
  let previousReport: Report | undefined;
  if (input.kind === 'closing' || input.mode === 'scheduled') {
    const existing = await ctx.tools.get_report.execute({
      kind: input.kind,
      scope: input.scope,
      periodEnd: input.periodEnd,
    });
    if (!existing.ok && existing.error.kind !== 'not_found') return existing;
    previousReport = existing.ok ? existing.data.report : undefined;
    if (
      previousReport !== undefined &&
      input.mode === 'scheduled' &&
      ((input.kind === 'closing' && !input.supplement) ||
        (input.kind !== 'closing' &&
          (previousReport.deliveryStatus === 'sent' ||
            previousReport.deliveryStatus === 'fallback-log')))
    ) {
      if (input.kind === 'closing' && input.notify && previousReport.deliveryStatus !== 'sent') {
        const attemptId = randomUUID();
        const claim = await ctx.tools.save_report.execute({
          report: previousReport,
          deliveryAttemptId: attemptId,
        });
        if (!claim.ok) return claim;
        if (claim.data.deliveryClaimed) {
          const delivery = await deliverClaimedReport(claim.data.report, attemptId, ctx);
          return {
            report: delivery.report,
            created: false,
            workflowRunId: previousReport.workflowRunId,
            notified: delivery.notified,
          };
        }
      }
      return {
        report: previousReport,
        created: false,
        workflowRunId: previousReport.workflowRunId,
        notified: false,
      };
    }
  }
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
    ...(input.kind === 'closing'
      ? {
          version: (previousReport?.version ?? 0) + 1,
          ...(previousReport === undefined ? {} : { supersedesReportId: previousReport.id }),
        }
      : {}),
    kind: input.kind,
    scope: input.scope,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    title:
      input.kind === 'closing' && previousReport !== undefined
        ? `${input.title}（补充 v${(previousReport.version ?? 1) + 1}）`
        : input.title,
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

  if (input.kind === 'closing' && !saved.data.created && !input.notify) {
    const audited = await ctx.tools.record_workflow_run.execute({
      run: {
        id: workflowRunId,
        workflowName: input.workflowName,
        mode: input.mode,
        status: saved.data.report.status === 'complete' ? 'succeeded' : 'partial',
        startedAt: generatedAt,
        finishedAt: ctx.clock(),
        inputSummary,
        outputSummary: {
          reportId: saved.data.report.id,
          reportStatus: saved.data.report.status,
          reused: true,
          notified: false,
          deliveryStatus: saved.data.report.deliveryStatus,
        },
        providerStatuses: [],
      },
    });
    if (!audited.ok) return audited;
    return { report: saved.data.report, created: false, workflowRunId, notified: false };
  }

  let deliveredReport = saved.data.report;
  const shouldNotify =
    input.notify &&
    (!input.supplement ||
      (previousReport !== undefined &&
        input.shouldNotifySupplement?.(previousReport, deliveredReport) === true));
  let notified = false;
  let notificationFailed = false;
  let notificationErrorKind: string | undefined;
  if (shouldNotify) {
    const attemptId = randomUUID();
    const claim = await ctx.tools.save_report.execute({
      report: deliveredReport,
      deliveryAttemptId: attemptId,
    });
    if (!claim.ok) {
      notificationFailed = true;
      notificationErrorKind = claim.error.kind;
    } else if (claim.data.deliveryClaimed) {
      const delivery = await deliverClaimedReport(claim.data.report, attemptId, ctx);
      deliveredReport = delivery.report;
      notified = delivery.notified;
      notificationFailed = delivery.failed;
      notificationErrorKind = delivery.errorKind;
    } else {
      deliveredReport = claim.data.report;
    }
  }

  const providerStatuses = evidence.map((item) => ({
    provider: item.provenance.provider,
    ok: item.provenance.freshness !== 'unavailable',
    ...(item.provenance.errorKind === undefined ? {} : { errorKind: item.provenance.errorKind }),
  }));
  if (shouldNotify) {
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
