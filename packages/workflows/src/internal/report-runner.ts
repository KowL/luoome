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
  readonly skippedByPolicy?: true;
  readonly errorKind?: string;
}> => {
  if (report.notificationPolicy === 'never')
    return { report, notified: false, failed: false, skippedByPolicy: true };
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
  if (input.kind === 'closing' || input.kind === 'weekly' || input.mode === 'scheduled') {
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
          input.kind !== 'weekly' &&
          (previousReport.deliveryStatus === 'sent' ||
            previousReport.deliveryStatus === 'fallback-log')))
    ) {
      if (input.kind === 'closing' && input.notify) {
        const main = await ctx.tools.get_report.execute({
          kind: input.kind,
          scope: input.scope,
          periodEnd: input.periodEnd,
          version: 1,
        });
        if (!main.ok) return main;
        const deliverable = main.data.report;
        if (deliverable.deliveryStatus === 'sent' || deliverable.notificationPolicy === 'never')
          return {
            report: previousReport,
            created: false,
            workflowRunId: previousReport.workflowRunId,
            notified: false,
          };
        const attemptId = randomUUID();
        const claim = await ctx.tools.save_report.execute({
          report: deliverable,
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

  let decisionReviewSnapshot: Report['decisionReviewSnapshot'];
  if (
    input.scope.kind === 'account' &&
    (input.kind === 'closing' || input.kind === 'weekly') &&
    input.template !== 'closing-historical-gap-v1'
  ) {
    const snapshot = await ctx.tools.get_decision_review_snapshot.execute({
      accountId: input.scope.accountId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    });
    if (!snapshot.ok) return snapshot;
    decisionReviewSnapshot = snapshot.data.snapshot;
    const since = new Date(`${input.periodStart}T00:00:00.000+08:00`);
    const until = new Date(`${input.periodEnd}T23:59:59.999+08:00`);
    const review = await ctx.tools.get_decision_loop_review.execute({
      accountId: input.scope.accountId,
      since,
      until,
      limit: 1000,
    });
    const evidenceId = `decision-review:${decisionReviewSnapshot.inputFingerprint}`;
    pieces = [
      ...pieces,
      {
        section: {
          key: 'decision-review',
          title: '账户决策与复盘',
          required: false,
          status: review.ok ? 'complete' : 'unavailable',
          dataAsOf: generatedAt,
          blocks: review.ok
            ? [
                {
                  kind: 'metrics',
                  items: [
                    {
                      key: 'decisionRecords',
                      label: '明确复盘记录',
                      value: review.data.decisionRecords.total,
                    },
                    {
                      key: 'linkedTrades',
                      label: '明确关联成交',
                      value: review.data.decisionRecords.linkedTrades,
                    },
                    {
                      key: 'pendingAdvice',
                      label: '待核对建议',
                      value: review.data.advice.pending,
                    },
                    {
                      key: 'triggerFeedback',
                      label: '提醒反馈',
                      value: review.data.decisionRecords.triggerFeedbackCount,
                    },
                  ],
                },
                {
                  kind: 'text',
                  tone: 'factual',
                  text: '以上为用户明确记录的账户事实；未知盈亏不计为零，不从提醒推断成交。',
                },
              ]
            : [
                {
                  kind: 'text',
                  tone: 'warning',
                  text: '账户复盘读取失败，历史报告仍保留已有区块。',
                },
              ],
          evidenceIds: review.ok ? [evidenceId] : [],
          missingDimensions: review.ok
            ? []
            : [
                {
                  dimension: 'decision-review',
                  reason: '账户复盘读取失败',
                  errorKind: review.error.kind,
                  retryable: true,
                },
              ],
        },
        evidence: review.ok
          ? [
              {
                id: evidenceId,
                dimension: 'decision-review',
                provenance: {
                  provider: 'local/decision-review',
                  observedAt: generatedAt,
                  fetchedAt: generatedAt,
                  freshness: 'fresh',
                },
              },
            ]
          : [],
      },
    ];
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
    ...(input.kind === 'closing' || input.kind === 'weekly'
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
      (input.kind === 'closing' || input.kind === 'weekly') && previousReport !== undefined
        ? `${input.title}（补充 v${(previousReport.version ?? 1) + 1}）`
        : input.title,
    generatedAt,
    dataAsOf: requiredAsOf.length === 0 ? generatedAt : new Date(Math.min(...requiredAsOf)),
    status,
    sections,
    evidence: [...evidence],
    missingDimensions,
    deliveryStatus: 'not-requested',
    notificationPolicy: 'eligible',
    ...(decisionReviewSnapshot === undefined ? {} : { decisionReviewSnapshot }),
    workflowRunId,
    createdAt: generatedAt,
    updatedAt: generatedAt,
  };
  const comparableSections = (value: Report) =>
    value.sections.map(({ dataAsOf: _dataAsOf, ...section }) => section);
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === 'object' && !(value instanceof Date)
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, nested]) => [key, canonical(nested)]),
          )
        : value;
  const unchangedWeekly =
    input.kind === 'weekly' &&
    previousReport !== undefined &&
    JSON.stringify(
      canonical({
        sections: comparableSections(previousReport),
        evidenceIds: previousReport.evidence.map((item) => item.id),
        missingDimensions: previousReport.missingDimensions,
      }),
    ) ===
      JSON.stringify(
        canonical({
          sections: comparableSections(report),
          evidenceIds: report.evidence.map((item) => item.id),
          missingDimensions: report.missingDimensions,
        }),
      );
  const reviewChangedWeeklySupplement =
    input.kind === 'weekly' &&
    previousReport !== undefined &&
    previousReport.decisionReviewSnapshot?.inputFingerprint !==
      report.decisionReviewSnapshot?.inputFingerprint;
  const reportToSave: Report = reviewChangedWeeklySupplement
    ? { ...report, notificationPolicy: 'never' }
    : report;
  const saved = await ctx.tools.save_report.execute({
    report: unchangedWeekly && previousReport !== undefined ? previousReport : reportToSave,
  });
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

  if (
    (input.kind === 'closing' || input.kind === 'weekly') &&
    !saved.data.created &&
    !input.notify
  ) {
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
    deliveredReport.notificationPolicy !== 'never' &&
    (deliveredReport.id === previousReport?.id
      ? deliveredReport.deliveryStatus !== 'sent'
      : (!input.supplement && (input.kind !== 'weekly' || previousReport === undefined)) ||
        (previousReport !== undefined &&
          input.shouldNotifySupplement?.(previousReport, deliveredReport) === true));
  let notified = false;
  let notificationFailed = false;
  let notificationSkippedByPolicy = false;
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
      notificationSkippedByPolicy = delivery.skippedByPolicy === true;
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
  if (shouldNotify && !notificationSkippedByPolicy) {
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
        ...(notificationSkippedByPolicy ? { notificationSkippedByPolicy: true } : {}),
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
