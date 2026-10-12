import { z } from 'zod';
import { type AlertPlan, AlertPlanSchema } from '../entity/alert-plan.js';
import { type Report, ReportSchema } from '../entity/report.js';
import { type WatchTrigger, WatchTriggerSchema } from '../entity/watch-trigger.js';
import {
  type Watchlist,
  type WatchlistMember,
  WatchlistMemberSchema,
  type WatchlistMemberSource,
  WatchlistMemberSourceSchema,
  WatchlistSchema,
} from '../entity/watchlist.js';
import { InvariantError } from '../error/index.js';
import {
  freezePersonalWatchTrigger,
  PersonalAlertPlanSchema,
  type PersonalWatchFeedback,
  PersonalWatchFeedbackSchema,
  PersonalWatchTriggerSnapshotSchema,
  TenantOperationReceiptSchema,
} from './tenant.js';

const Id = z.string().min(1).max(160);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Generation = z.number().int().positive().safe();
const Time = z.coerce.date();

export const HostedExportMetadataSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
  tenantId: Id,
  generation: Generation,
  requestId: Id,
  operationId: Id,
  inputHash: Hash,
  state: z.enum(['requested', 'ready', 'failed', 'expired']),
  artifactRef: Id.nullable(),
  resultHash: Hash.nullable(),
  byteLength: z.number().int().nonnegative().safe().nullable(),
  createdAt: Time,
  expiresAt: Time,
  completedAt: Time.nullable(),
  errorKind: z.string().max(100).nullable(),
});
export type HostedExportMetadata = z.infer<typeof HostedExportMetadataSchema>;
export const HostedDeletionSchema = z.object({
  id: Id,
  tenantId: Id,
  userId: Id,
  generation: Generation,
  requestId: Id,
  state: z.enum(['draining', 'needs-review', 'completed']),
  createdAt: Time,
  completedAt: Time.nullable(),
  errorKind: z.string().max(100).nullable(),
});
export type HostedDeletion = z.infer<typeof HostedDeletionSchema>;

const ExportSource = WatchlistMemberSourceSchema.pick({
  id: true,
  memberId: true,
  kind: true,
  sourceKey: true,
  reason: true,
  status: true,
  evidence: true,
  validFrom: true,
  validUntil: true,
});
const ExportReport = ReportSchema.pick({
  id: true,
  version: true,
  supersedesReportId: true,
  kind: true,
  scope: true,
  periodStart: true,
  periodEnd: true,
  title: true,
  generatedAt: true,
  dataAsOf: true,
  status: true,
  sections: true,
  evidence: true,
  missingDimensions: true,
  createdAt: true,
  updatedAt: true,
});
const ExportFeedback = PersonalWatchFeedbackSchema.pick({
  triggerId: true,
  triggerSnapshot: true,
  revision: true,
  rating: true,
  note: true,
  recordedAt: true,
});
export const TenantExportSnapshotSchema = z.object({
  format: z.literal('luoome-personal-data'),
  formatVersion: z.literal(1),
  operationId: Id,
  generation: Generation,
  createdAt: Time,
  watchlists: z.array(WatchlistSchema),
  members: z.array(WatchlistMemberSchema),
  sources: z.array(ExportSource),
  alertPlans: z.array(PersonalAlertPlanSchema),
  triggers: z.array(PersonalWatchTriggerSnapshotSchema),
  reports: z.array(ExportReport),
  feedback: z.array(ExportFeedback),
});
export type TenantExportSnapshot = z.infer<typeof TenantExportSnapshotSchema>;
export const TenantExportSnapshotRecordSchema = z.object({
  operationId: Id,
  inputHash: Hash,
  generation: Generation,
  snapshot: TenantExportSnapshotSchema,
  receipt: TenantOperationReceiptSchema,
});
export type TenantExportSnapshotRecord = z.infer<typeof TenantExportSnapshotRecordSchema>;
export const TenantExportRequestSchema = z.object({
  operationId: Id,
  inputHash: Hash,
  generation: Generation,
  now: Time,
});
export type TenantExportRequest = z.infer<typeof TenantExportRequestSchema>;
export interface TenantExportRepository {
  createSnapshot(
    input: TenantExportRequest,
  ): Promise<TenantExportSnapshotRecord & { readonly replayed: boolean }>;
  findSnapshot(operationId: string): Promise<TenantExportSnapshotRecord | null>;
}

export interface TenantExportSourceData {
  readonly watchlists: readonly Watchlist[];
  readonly members: readonly WatchlistMember[];
  readonly sources: readonly WatchlistMemberSource[];
  readonly alertPlans: readonly AlertPlan[];
  readonly triggers: readonly WatchTrigger[];
  readonly reports: readonly Report[];
  readonly feedback: readonly PersonalWatchFeedback[];
}

export const projectTenantExport = (
  request: TenantExportRequest,
  data: TenantExportSourceData,
): TenantExportSnapshot => {
  const ordered = <T extends { readonly id: string }>(rows: readonly T[]) =>
    [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const watchlists = ordered(
    data.watchlists
      .filter((row) => row.kind === 'personal')
      .map((row) => WatchlistSchema.parse(row)),
  );
  const watchlistIds = new Set(watchlists.map((row) => row.id));
  const members = ordered(
    data.members
      .filter((row) => watchlistIds.has(row.watchlistId))
      .map((row) => WatchlistMemberSchema.parse(row)),
  );
  const memberIds = new Set(members.map((row) => row.id));
  const sources = ordered(
    data.sources
      .filter((row) => memberIds.has(row.memberId) && ['manual', 'import'].includes(row.kind))
      .map((row) => ExportSource.parse(row)),
  );
  const alertPlans = ordered(
    data.alertPlans
      .filter(
        (row) =>
          watchlistIds.has(row.watchlistId) &&
          row.rules.every((rule) => ['price-level', 'price-change'].includes(rule.kind)),
      )
      .map((row) => PersonalAlertPlanSchema.parse(AlertPlanSchema.parse(row))),
  );
  const triggers = ordered(
    data.triggers
      .filter(
        (row) =>
          row.direction === 'watch' && ['price-level', 'price-change'].includes(row.ruleKind),
      )
      .map((row) => freezePersonalWatchTrigger(WatchTriggerSchema.parse(row))),
  );
  const reports = ordered(
    data.reports
      .filter(
        (row) =>
          row.kind === 'watchlist-facts' &&
          row.scope.kind === 'watchlist' &&
          watchlistIds.has(row.scope.watchlistId),
      )
      .map((row) => {
        if (
          row.sections.some((section) =>
            section.blocks.some(
              (block) =>
                block.kind === 'list' &&
                block.items.some(
                  (item) => item.entityKind === 'advice' || item.entityKind === 'trading-plan',
                ),
            ),
          )
        ) {
          throw new InvariantError('facts export cannot contain advice or trading plans');
        }
        return ExportReport.parse(row);
      }),
  );
  const feedback = [...data.feedback]
    .sort((a, b) => a.triggerId.localeCompare(b.triggerId) || a.revision - b.revision)
    .map((row) =>
      ExportFeedback.parse({
        ...row,
        triggerSnapshot: freezePersonalWatchTrigger(row.triggerSnapshot),
      }),
    );
  return TenantExportSnapshotSchema.parse({
    format: 'luoome-personal-data',
    formatVersion: 1,
    operationId: request.operationId,
    generation: request.generation,
    createdAt: request.now,
    watchlists,
    members,
    sources,
    alertPlans,
    triggers,
    reports,
    feedback,
  });
};

export const assertHostedExportMetadata = (metadata: HostedExportMetadata): void => {
  if (
    metadata.expiresAt <= metadata.createdAt ||
    metadata.expiresAt.getTime() - metadata.createdAt.getTime() > 24 * 60 * 60_000
  )
    throw new InvariantError('export lifetime must not exceed 24 hours');
  if (
    metadata.state === 'ready' &&
    (metadata.artifactRef !== metadata.id ||
      metadata.resultHash === null ||
      metadata.byteLength === null ||
      metadata.completedAt === null)
  )
    throw new InvariantError('ready export requires a private artifact receipt');
};
