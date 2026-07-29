import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { DataProvenanceSchema } from './provenance.js';
import { DeliveryStatusSchema } from './stock-pool.js';

export const ReportKindSchema = z.enum(['opening', 'closing', 'weekly']);
export type ReportKind = z.infer<typeof ReportKindSchema>;

export const ReportStatusSchema = z.enum(['complete', 'partial']);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

export const ReportSectionStatusSchema = z.enum(['complete', 'partial', 'unavailable']);
export type ReportSectionStatus = z.infer<typeof ReportSectionStatusSchema>;

export const ReportValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type ReportValue = z.infer<typeof ReportValueSchema>;

export const ReportScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all-accounts') }),
  z.object({ kind: z.literal('account'), accountId: z.string().min(1) }),
]);
export type ReportScope = z.infer<typeof ReportScopeSchema>;

export const reportScopeKey = (scope: ReportScope): string =>
  scope.kind === 'all-accounts' ? 'all-accounts' : `account:${scope.accountId}`;

const MetricBlockSchema = z.object({
  kind: z.literal('metrics'),
  items: z.array(
    z.object({
      key: z.string().min(1),
      label: z.string().min(1),
      value: ReportValueSchema,
      unit: z.string().optional(),
      displayValue: z.string().optional(),
    }),
  ),
});

const TableBlockSchema = z.object({
  kind: z.literal('table'),
  columns: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .min(1),
  rows: z.array(z.record(z.string(), ReportValueSchema)),
});

const ListBlockSchema = z.object({
  kind: z.literal('list'),
  items: z.array(
    z
      .object({
        title: z.string().min(1),
        detail: z.string().optional(),
        entityKind: z
          .enum([
            'stock',
            'strategy',
            'watchlist',
            'alert-plan',
            'watch-trigger',
            'stock-event',
            'research-note',
            'advice',
          ])
          .optional(),
        entityId: z.string().optional(),
      })
      .refine((item) => (item.entityKind === undefined) === (item.entityId === undefined), {
        message: 'entityKind and entityId must appear together',
      }),
  ),
});

const TextBlockSchema = z.object({
  kind: z.literal('text'),
  text: z.string().min(1),
  tone: z.enum(['factual', 'warning']).default('factual'),
});

export const ReportBlockSchema = z.discriminatedUnion('kind', [
  MetricBlockSchema,
  TableBlockSchema,
  ListBlockSchema,
  TextBlockSchema,
]);
export type ReportBlock = z.infer<typeof ReportBlockSchema>;

export const ReportEvidenceSchema = z.object({
  id: z.string().min(1),
  dimension: z.string().min(1),
  provenance: DataProvenanceSchema,
});
export type ReportEvidence = z.infer<typeof ReportEvidenceSchema>;

export const ReportMissingDimensionSchema = z.object({
  dimension: z.string().min(1),
  reason: z.string().min(1).max(500),
  errorKind: z.string().optional(),
  retryable: z.boolean(),
});
export type ReportMissingDimension = z.infer<typeof ReportMissingDimensionSchema>;

export const ReportSectionSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  required: z.boolean(),
  status: ReportSectionStatusSchema,
  dataAsOf: z.coerce.date().optional(),
  blocks: z.array(ReportBlockSchema),
  evidenceIds: z.array(z.string()).default([]),
  missingDimensions: z.array(ReportMissingDimensionSchema).default([]),
});
export type ReportSection = z.infer<typeof ReportSectionSchema>;

export const ReportSchema = z.object({
  id: z.string().min(1),
  kind: ReportKindSchema,
  scope: ReportScopeSchema,
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  title: z.string().min(1).max(200),
  generatedAt: z.coerce.date(),
  dataAsOf: z.coerce.date(),
  status: ReportStatusSchema,
  sections: z.array(ReportSectionSchema).min(1),
  evidence: z.array(ReportEvidenceSchema),
  missingDimensions: z.array(ReportMissingDimensionSchema).default([]),
  deliveryStatus: DeliveryStatusSchema.default('not-requested'),
  workflowRunId: z.string().min(1),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Report = z.infer<typeof ReportSchema>;

const weekStart = (date: string): string => {
  const value = new Date(`${date}T00:00:00.000Z`);
  const daysSinceMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - daysSinceMonday);
  return value.toISOString().slice(0, 10);
};

const ADVICE_DECISION_FIELDS = new Set([
  'decision',
  'positionSize',
  'stopLoss',
  'takeProfit',
  'confidence',
]);

const findAdviceDecisionField = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAdviceDecisionField(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  for (const [key, nested] of Object.entries(value)) {
    if (ADVICE_DECISION_FIELDS.has(key)) return key;
    const found = findAdviceDecisionField(nested);
    if (found !== null) return found;
  }
  return null;
};

export const assertReportInvariants = (report: Report): void => {
  if (report.periodStart > report.periodEnd) {
    throw new InvariantError('report periodStart > periodEnd');
  }
  if (report.dataAsOf.getTime() > report.generatedAt.getTime()) {
    throw new InvariantError('report dataAsOf > generatedAt');
  }
  if (report.updatedAt.getTime() < report.createdAt.getTime()) {
    throw new InvariantError('report updatedAt < createdAt');
  }
  if (report.kind !== 'weekly' && report.periodStart !== report.periodEnd) {
    throw new InvariantError(`${report.kind} report period must be one trading day`);
  }
  if (report.kind === 'weekly' && weekStart(report.periodStart) !== weekStart(report.periodEnd)) {
    throw new InvariantError('weekly report period must stay within one Shanghai natural week');
  }
  const sectionKeys = new Set(report.sections.map((section) => section.key));
  if (sectionKeys.size !== report.sections.length) {
    throw new InvariantError('report section key must be unique');
  }
  const evidenceIds = new Set(report.evidence.map((evidence) => evidence.id));
  if (evidenceIds.size !== report.evidence.length) {
    throw new InvariantError('report evidence id must be unique');
  }
  for (const section of report.sections) {
    for (const evidenceId of section.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new InvariantError(`report evidence reference not found: ${evidenceId}`);
      }
    }
    if (section.status === 'complete' && section.missingDimensions.length > 0) {
      throw new InvariantError(`complete report section has missing dimensions: ${section.key}`);
    }
    if (
      section.status === 'unavailable' &&
      section.blocks.some((block) => block.kind !== 'text' || block.tone !== 'warning')
    ) {
      throw new InvariantError(
        `unavailable report section may only contain warning text: ${section.key}`,
      );
    }
  }
  const allRequiredComplete = report.sections
    .filter((section) => section.required)
    .every((section) => section.status === 'complete');
  if (allRequiredComplete !== (report.status === 'complete')) {
    throw new InvariantError('report status does not match required section status');
  }
  if (
    report.status === 'partial' &&
    report.missingDimensions.length === 0 &&
    report.sections.every((section) => section.missingDimensions.length === 0)
  ) {
    throw new InvariantError('partial report requires at least one missing dimension');
  }
  const decisionField = findAdviceDecisionField(
    report.sections.flatMap((section) => section.blocks),
  );
  if (decisionField !== null) {
    throw new InvariantError(`report block contains Advice decision field: ${decisionField}`);
  }
};

export const assertReportDeliveryTransition = (
  from: Report['deliveryStatus'],
  to: Report['deliveryStatus'],
): void => {
  if (from === 'sent' && to === 'pending') {
    throw new InvariantError('sent report deliveryStatus cannot return to pending');
  }
};
