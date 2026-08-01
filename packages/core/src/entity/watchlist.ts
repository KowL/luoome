import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { ReportMissingDimensionSchema } from './report.js';

const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);

export const WatchlistKindSchema = z.enum(['personal', 'strategy', 'portfolio', 'system']);
export type WatchlistKind = z.infer<typeof WatchlistKindSchema>;
export const WatchlistMembershipPolicySchema = z.enum(['manual', 'synced', 'mixed']);

export const WatchlistSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(1000).optional(),
  kind: WatchlistKindSchema,
  membershipPolicy: WatchlistMembershipPolicySchema,
  enabled: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Watchlist = z.infer<typeof WatchlistSchema>;

export const WatchlistMemberStageSchema = z.enum([
  'discovered',
  'watching',
  'researching',
  'confirmed',
  'archived',
]);
export const WatchlistMemberPrioritySchema = z.enum(['normal', 'important', 'urgent']);
export const WatchlistMemberSchema = z.object({
  id: z.string().min(1),
  watchlistId: z.string().min(1),
  stockId: z.string().min(1),
  stage: WatchlistMemberStageSchema,
  priority: WatchlistMemberPrioritySchema,
  firstAddedAt: z.coerce.date(),
  lastActivityAt: z.coerce.date(),
  archivedAt: z.coerce.date().optional(),
});
export type WatchlistMember = z.infer<typeof WatchlistMemberSchema>;

export const WatchlistMemberSourceKindSchema = z.enum([
  'manual',
  'strategy',
  'ai',
  'portfolio',
  'import',
]);
export const WatchlistMemberSourceStatusSchema = z.enum(['active', 'stale', 'ended']);
export const WatchlistMemberSourceSchema = z.object({
  id: z.string().min(1),
  memberId: z.string().min(1),
  kind: WatchlistMemberSourceKindSchema,
  sourceKey: z.string().min(1),
  sourceId: z.string().optional(),
  sourceVersionId: z.string().optional(),
  syncRunId: z.string().optional(),
  reason: z.string().min(1).max(1000),
  score: z.number().min(0).max(100).optional(),
  rank: z.number().int().positive().optional(),
  status: WatchlistMemberSourceStatusSchema,
  evidence: z.array(z.string()),
  dataAsOf: z.coerce.date().optional(),
  validFrom: z.coerce.date(),
  validUntil: z.coerce.date().optional(),
});
export type WatchlistMemberSource = z.infer<typeof WatchlistMemberSourceSchema>;

export const WatchlistSyncRunSchema = z.object({
  id: z.string().min(1),
  watchlistId: z.string().min(1),
  sourceKind: z.enum(['strategy', 'ai', 'portfolio', 'import']),
  sourceKey: z.string().min(1),
  producerRunId: z.string().optional(),
  status: z.enum(['running', 'complete', 'partial', 'failed']),
  dataAsOf: z.coerce.date().optional(),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().optional(),
  enteredCount: z.number().int().nonnegative(),
  exitedCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  missingDimensions: z.array(ReportMissingDimensionSchema),
  error: z.string().optional(),
});
export type WatchlistSyncRun = z.infer<typeof WatchlistSyncRunSchema>;

export const MembershipSnapshotSchema = z.object({
  id: z.string().min(1),
  syncRunId: z.string().min(1),
  stockId: z.string().min(1),
  selected: z.boolean(),
  change: z.enum(['entered', 'unchanged', 'exited']),
  reason: z.string().min(1),
  score: z.number().min(0).max(100).optional(),
  rank: z.number().int().positive().optional(),
  evidence: z.array(z.string()),
  dataAsOf: z.coerce.date().optional(),
});
export type MembershipSnapshot = z.infer<typeof MembershipSnapshotSchema>;

export const WatchlistSourceCandidateSchema = z.object({
  stockId: z.string().min(1),
  reason: z.string().min(1).max(1000),
  score: z.number().min(0).max(100).optional(),
  rank: z.number().int().positive().optional(),
  evidence: z.array(z.string()),
  dataAsOf: z.coerce.date().optional(),
});
export type WatchlistSourceCandidate = z.infer<typeof WatchlistSourceCandidateSchema>;

export interface WatchlistSyncCommit {
  readonly run: WatchlistSyncRun;
  readonly candidates: readonly WatchlistSourceCandidate[];
  readonly sourceId?: string;
  readonly sourceVersionId?: string;
  /** archived Member 的恢复目标：自动来源默认 discovered；仅用户手工恢复可选 watching。 */
  readonly reviveStage?: 'discovered' | 'watching';
}

export const assertWatchlistInvariants = (watchlist: Watchlist): void => {
  WatchlistSchema.parse(watchlist);
  if (watchlist.updatedAt < watchlist.createdAt) {
    throw new InvariantError('Watchlist.updatedAt 不能早于 createdAt');
  }
  if (watchlist.kind === 'portfolio' && watchlist.membershipPolicy !== 'synced') {
    throw new InvariantError('portfolio Watchlist 必须 membershipPolicy=synced');
  }
  if (watchlist.kind === 'system' && watchlist.membershipPolicy === 'manual') {
    throw new InvariantError('system Watchlist 不允许 membershipPolicy=manual');
  }
};

export const assertWatchlistMemberInvariants = (member: WatchlistMember): void => {
  WatchlistMemberSchema.parse(member);
  if (member.lastActivityAt < member.firstAddedAt) {
    throw new InvariantError('WatchlistMember.lastActivityAt 不能早于 firstAddedAt');
  }
  if ((member.stage === 'archived') !== (member.archivedAt !== undefined)) {
    throw new InvariantError('archived WatchlistMember 与 archivedAt 必须同时出现');
  }
};

export const assertWatchlistMemberSourceInvariants = (source: WatchlistMemberSource): void => {
  WatchlistMemberSourceSchema.parse(source);
  if (!source.sourceKey.startsWith(`${source.kind}:`)) {
    throw new InvariantError('WatchlistMemberSource.sourceKey 前缀必须与 kind 一致');
  }
  if ((source.status === 'ended') !== (source.validUntil !== undefined)) {
    throw new InvariantError('ended WatchlistMemberSource 与 validUntil 必须同时出现');
  }
  if (source.validUntil !== undefined && source.validUntil < source.validFrom) {
    throw new InvariantError('WatchlistMemberSource.validUntil 不能早于 validFrom');
  }
};

export const assertWatchlistSyncRunInvariants = (run: WatchlistSyncRun): void => {
  WatchlistSyncRunSchema.parse(run);
  if (!run.sourceKey.startsWith(`${run.sourceKind}:`)) {
    throw new InvariantError('WatchlistSyncRun.sourceKey 前缀必须与 sourceKind 一致');
  }
  if ((run.status === 'running') !== (run.finishedAt === undefined)) {
    throw new InvariantError(
      'WatchlistSyncRun running 不得有 finishedAt，complete/partial/failed 必须有 finishedAt',
    );
  }
  if (run.finishedAt !== undefined && run.finishedAt < run.startedAt) {
    throw new InvariantError('WatchlistSyncRun.finishedAt 不能早于 startedAt');
  }
  if (run.status === 'failed' && run.error === undefined) {
    throw new InvariantError('failed WatchlistSyncRun 必须有 error');
  }
  if (run.status !== 'complete' && run.exitedCount > 0) {
    throw new InvariantError('只有 complete WatchlistSyncRun 可以产生 exited');
  }
};
