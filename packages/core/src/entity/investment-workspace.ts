import { z } from 'zod';
import { InvariantError } from '../error/index.js';
import { addTradingDays, dateInShanghai, isHoliday, isWeekend } from '../trading-calendar.js';
import { STANDARD_DISCLAIMERS } from './advice.js';
import { AnalysisProvenanceSchema } from './analysis-provenance.js';
import { AShareSentimentSnapshotSchema } from './ashare-sentiment.js';
import { DataProvenanceSchema } from './provenance.js';

const Text = z.string().trim().min(1).max(2000);
const Id = z.string().min(1).max(200);

const StrategyInvestmentEvidenceSchema = z.object({
  id: Id,
  strategyId: Id,
  strategyVersionId: Id,
  runId: Id,
  dataAsOf: z.coerce.date(),
  kind: z.enum(['coverage', 'selection', 'rule', 'consensus']),
  text: Text,
  stockId: Id.optional(),
});
export const InvestmentMarketSourceSchema = z.object({
  kind: z.literal('market-snapshot'),
  snapshotId: Id,
  subject: Id,
});
export const MarketInvestmentEvidenceSchema = z.object({
  id: Id,
  source: InvestmentMarketSourceSchema,
  dataAsOf: z.coerce.date(),
  kind: z.enum([
    'market-breadth',
    'market-indexes',
    'market-sentiment',
    'market-pool-industry',
    'consensus',
  ]),
  text: Text,
  value: z.record(z.string(), z.unknown()),
  provenance: z.array(DataProvenanceSchema).min(1),
});
export type MarketInvestmentEvidence = z.infer<typeof MarketInvestmentEvidenceSchema>;
export const InvestmentEvidenceSchema = z.union([
  StrategyInvestmentEvidenceSchema,
  MarketInvestmentEvidenceSchema,
]);
export type InvestmentEvidence = z.infer<typeof InvestmentEvidenceSchema>;

export const InvestmentObjectionSchema = z.object({
  kind: z.enum(['known-risk', 'missing-evidence', 'plan-conflict']),
  conclusion: Text,
  evidenceIds: z.array(Id).max(30),
  risks: z.array(Text).min(1).max(10),
  unknowns: z.array(Text).max(10),
  reconsiderWhen: z.array(Text).min(1).max(10),
  alternatives: z.array(Text).min(1).max(10),
});

const InvestmentDirectionFields = {
  id: Id,
  name: z.string().trim().min(1).max(80),
  rank: z.number().int().min(1).max(3),
  stance: z.enum(['prefer', 'observe', 'oppose']),
  rationale: Text,
  comparisonReason: Text,
  evidenceIds: z.array(Id).min(1).max(30),
  objections: z.array(InvestmentObjectionSchema).min(1).max(10),
  risks: z.array(Text).min(1).max(10),
  waitFor: z.array(Text).min(1).max(10),
  abandonWhen: z.array(Text).min(1).max(10),
  reviewWhen: z.array(Text).min(1).max(10),
  horizon: z.enum(['short', 'medium', 'long']),
  accountFit: z.literal('research-only'),
  dataAsOf: z.coerce.date(),
  validUntil: z.coerce.date(),
};
export const StrategyInvestmentDirectionSchema = z.object({
  ...InvestmentDirectionFields,
  opportunityType: z.literal('strategy-selection'),
  strategyId: Id,
  strategyVersionId: Id,
  runId: Id,
  coverage: z.object({
    kind: z.enum(['strategy-universe', 'explicit-subset']),
    universeCount: z.number().int().nonnegative(),
    evaluatedCount: z.number().int().nonnegative(),
    selectedCount: z.number().int().nonnegative(),
    dataHealth: z.enum(['complete', 'partial']),
    description: Text,
  }),
});
export type StrategyInvestmentDirection = z.infer<typeof StrategyInvestmentDirectionSchema>;
export const MarketInvestmentDirectionSchema = z
  .object({
    ...InvestmentDirectionFields,
    opportunityType: z.literal('market-participation'),
    source: InvestmentMarketSourceSchema,
    coverage: z.object({
      kind: z.literal('market-facts'),
      scope: z.enum(['CN_A_SHARES_SH_SZ', 'cn-equity-indexes', 'limit-up-and-broken-board-pools']),
      observedCount: z.number().int().nonnegative(),
      unit: z.enum(['stocks', 'indexes', 'pool-stocks']),
      dataHealth: z.enum(['complete', 'partial']),
      description: Text,
    }),
    tracking: z.object({ eligible: z.literal(false), reason: Text }),
  })
  .strict();
export type MarketInvestmentDirection = z.infer<typeof MarketInvestmentDirectionSchema>;
export const InvestmentDirectionSchema = z.discriminatedUnion('opportunityType', [
  StrategyInvestmentDirectionSchema,
  MarketInvestmentDirectionSchema,
]);
export type InvestmentDirection = z.infer<typeof InvestmentDirectionSchema>;

export const investmentDirectionIdentity = (direction: InvestmentDirection): string =>
  direction.opportunityType === 'strategy-selection'
    ? `strategy:${direction.strategyId}`
    : `market:${direction.source.subject}`;

export const InvestmentUnmappedDirectionSchema = z.object({ directionId: Id, reason: Text });

export const InvestmentDiscussionSourceSchema = z.object({
  sessionId: Id.optional(),
  messageId: Id.optional(),
  userText: Text,
});

export const InvestmentResearchSchema = z.object({
  provenance: AnalysisProvenanceSchema.optional(),
  id: Id,
  ownerUserId: Id,
  accountId: Id,
  requestId: Id,
  requestHash: Id,
  question: Text,
  status: z.enum(['complete', 'unavailable', 'failed']),
  source: InvestmentDiscussionSourceSchema,
  directions: z.array(InvestmentDirectionSchema).max(3),
  evidence: z.array(InvestmentEvidenceSchema).max(300),
  limitations: z.array(Text).min(1),
  disclaimers: z.array(Text).min(1),
  createdAt: z.coerce.date(),
  marketSnapshot: z.object({ id: Id, snapshot: AShareSentimentSnapshotSchema }).optional(),
});
export type InvestmentResearch = z.infer<typeof InvestmentResearchSchema>;

export const InvestmentRecentIntentSchema = z.object({
  mode: z.enum(['balanced', 'cautious', 'holdings-first', 'pause-new-opportunities']),
  note: Text,
  startsAt: z.coerce.date(),
  reviewAt: z.coerce.date(),
});

export const InvestmentSelectionSchema = z.object({
  researchId: Id,
  directionId: Id,
  role: z.enum(['primary', 'observe', 'avoid']),
  userReason: Text,
  direction: InvestmentDirectionSchema,
});
export type InvestmentSelection = z.infer<typeof InvestmentSelectionSchema>;

export const InvestmentConsensusSchema = z.object({
  id: Id,
  ownerUserId: Id,
  accountId: Id,
  version: z.number().int().positive(),
  supersedesId: Id.nullable(),
  status: z.enum(['confirmed', 'revoked']),
  selections: z.array(InvestmentSelectionSchema).max(3),
  constraints: z.array(Text).max(20),
  recentIntent: InvestmentRecentIntentSchema.nullable(),
  source: InvestmentDiscussionSourceSchema,
  changeNote: Text,
  effectScope: z.literal('future-research-only'),
  reviewAt: z.coerce.date(),
  validUntil: z.coerce.date(),
  createdAt: z.coerce.date(),
});
export type InvestmentConsensus = z.infer<typeof InvestmentConsensusSchema>;

export const InvestmentTrackingItemSchema = z.object({
  strategyId: Id,
  directionId: Id,
  watchlistId: Id,
  subscriptionId: Id.nullable(),
  syncRunId: Id.nullable(),
  status: z.enum(['tracking', 'failed', 'paused']),
  reason: Text,
});
export const InvestmentTrackingSchema = z.object({
  id: Id,
  ownerUserId: Id,
  accountId: Id,
  consensusVersion: z.number().int().positive(),
  requestId: Id,
  requestHash: Id,
  action: z.enum(['start', 'pause']),
  status: z.enum(['starting', 'tracking', 'partial', 'failed', 'paused']),
  items: z.array(InvestmentTrackingItemSchema),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
  unmappedDirections: z.array(InvestmentUnmappedDirectionSchema).optional(),
});
export type InvestmentTracking = z.infer<typeof InvestmentTrackingSchema>;

// 盘后方向只作下一轮研究输入；盘中仍允许读取上一收盘事实，但不能声称实时。
export const investmentEvidenceValidUntil = (dataAsOf: Date): Date =>
  new Date(`${dateInShanghai(addTradingDays(dataAsOf, 1))}T16:30:00+08:00`);

export const isInvestmentEvidenceCurrent = (dataAsOf: Date, now: Date): boolean =>
  dataAsOf <= now &&
  !isHoliday(dataAsOf) &&
  !isWeekend(dataAsOf) &&
  now < investmentEvidenceValidUntil(dataAsOf);

export const investmentMarketEvidenceValidUntil = (observedAt: Date): Date => {
  const day = dateInShanghai(observedAt);
  const close = new Date(`${day}T15:00:00+08:00`);
  return observedAt < close
    ? new Date(Math.min(observedAt.getTime() + 20 * 60_000, close.getTime()))
    : new Date(`${dateInShanghai(addTradingDays(observedAt, 1))}T09:30:00+08:00`);
};

export const isInvestmentMarketEvidenceCurrent = (observedAt: Date, now: Date): boolean =>
  observedAt <= now &&
  !isWeekend(observedAt) &&
  !isHoliday(observedAt) &&
  now < investmentMarketEvidenceValidUntil(observedAt);

export const investmentConsensusState = (
  consensus: InvestmentConsensus,
  now: Date,
): 'confirmed' | 'revoked' | 'expired' | 'review-required' => {
  if (consensus.status === 'revoked') return 'revoked';
  if (now >= consensus.validUntil) return 'expired';
  if (now >= consensus.reviewAt) return 'review-required';
  if (
    consensus.selections.some(
      (selection) =>
        selection.role !== 'avoid' &&
        selection.direction.opportunityType === 'market-participation' &&
        now >= selection.direction.validUntil,
    )
  )
    return 'review-required';
  if (consensus.recentIntent !== null && now >= consensus.recentIntent.reviewAt)
    return 'review-required';
  return 'confirmed';
};

export const assertInvestmentResearchInvariants = (research: InvestmentResearch): void => {
  InvestmentResearchSchema.parse(research);
  if (STANDARD_DISCLAIMERS.some((disclaimer) => !research.disclaimers.includes(disclaimer))) {
    throw new InvariantError('investment research requires standard disclaimers');
  }
  if ((research.status === 'complete') !== research.directions.length > 0) {
    throw new InvariantError(
      'complete research requires directions; unavailable research has none',
    );
  }
  const facts = new Map(research.evidence.map((fact) => [fact.id, fact]));
  if (facts.size !== research.evidence.length) throw new InvariantError('duplicate evidence id');
  const directions = new Set<string>();
  const ranks = new Set<number>();
  for (const direction of research.directions) {
    if (directions.has(direction.id) || ranks.has(direction.rank)) {
      throw new InvariantError('duplicate direction or rank');
    }
    directions.add(direction.id);
    ranks.add(direction.rank);
    if (direction.dataAsOf > research.createdAt || direction.validUntil <= research.createdAt) {
      throw new InvariantError('direction evidence must be current when created');
    }
    for (const ref of [
      ...direction.evidenceIds,
      ...direction.objections.flatMap((objection) => objection.evidenceIds),
    ]) {
      const fact = facts.get(ref);
      const matches =
        fact !== undefined &&
        (direction.opportunityType === 'strategy-selection'
          ? 'strategyId' in fact &&
            fact.strategyId === direction.strategyId &&
            fact.strategyVersionId === direction.strategyVersionId &&
            fact.runId === direction.runId
          : 'source' in fact &&
            fact.source.snapshotId === direction.source.snapshotId &&
            fact.source.subject === direction.source.subject);
      if (!matches) throw new InvariantError('direction references missing or foreign evidence');
    }
    if (direction.opportunityType === 'market-participation') {
      const snapshot = research.marketSnapshot;
      if (snapshot === undefined || snapshot.id !== direction.source.snapshotId)
        throw new InvariantError('market direction requires its immutable source snapshot');
      if (
        direction.validUntil.getTime() !==
        investmentMarketEvidenceValidUntil(direction.dataAsOf).getTime()
      )
        throw new InvariantError('market direction validity must follow source observation time');
      const supporting = direction.evidenceIds.map((id) => facts.get(id));
      if (supporting.some((fact) => fact?.kind === 'consensus'))
        throw new InvariantError('user choices cannot replace market evidence');
      if (
        supporting.some(
          (fact) =>
            fact === undefined ||
            !('source' in fact) ||
            fact.dataAsOf.getTime() !== direction.dataAsOf.getTime() ||
            !isInvestmentMarketEvidenceCurrent(fact.dataAsOf, research.createdAt) ||
            Math.min(...fact.provenance.map((provenance) => provenance.observedAt.getTime())) !==
              fact.dataAsOf.getTime() ||
            fact.provenance.some(
              (provenance) =>
                provenance.freshness !== 'fresh' ||
                !isInvestmentMarketEvidenceCurrent(provenance.observedAt, research.createdAt),
            ),
        )
      )
        throw new InvariantError(
          'market evidence must retain qualified observation time and provenance',
        );
    }
    for (const objection of direction.objections) {
      if (objection.kind === 'known-risk' && objection.evidenceIds.length === 0) {
        throw new InvariantError('known risk requires referenced facts');
      }
      if (
        objection.kind === 'plan-conflict' &&
        !objection.evidenceIds.some((id) => facts.get(id)?.kind === 'consensus')
      ) {
        throw new InvariantError('plan conflict requires confirmed consensus evidence');
      }
    }
  }
};

export const investmentResearchEnabled = (consensus: InvestmentConsensus, now: Date): boolean => {
  if (investmentConsensusState(consensus, now) !== 'confirmed') return false;
  const intent = consensus.recentIntent;
  return !(
    intent !== null &&
    intent.startsAt <= now &&
    now < intent.reviewAt &&
    intent.mode === 'pause-new-opportunities'
  );
};

export const assertInvestmentConsensusInvariants = (consensus: InvestmentConsensus): void => {
  InvestmentConsensusSchema.parse(consensus);
  if ((consensus.version === 1) !== (consensus.supersedesId === null)) {
    throw new InvariantError('consensus version chain is invalid');
  }
  if (consensus.reviewAt > consensus.validUntil || consensus.validUntil <= consensus.createdAt) {
    throw new InvariantError('consensus review/expiry time is invalid');
  }
  if (
    consensus.recentIntent !== null &&
    consensus.recentIntent.reviewAt <= consensus.recentIntent.startsAt
  ) {
    throw new InvariantError('recent intent reviewAt must follow startsAt');
  }
  if (consensus.selections.filter((selection) => selection.role === 'primary').length > 1) {
    throw new InvariantError('only one primary direction is allowed');
  }
  const ids = new Set<string>();
  for (const selection of consensus.selections) {
    if (
      selection.directionId !== selection.direction.id ||
      ids.has(investmentDirectionIdentity(selection.direction))
    ) {
      throw new InvariantError('direction identity is invalid or strategy is selected twice');
    }
    ids.add(investmentDirectionIdentity(selection.direction));
  }
};

export const assertInvestmentTrackingInvariants = (tracking: InvestmentTracking): void => {
  InvestmentTrackingSchema.parse(tracking);
  if ((tracking.status === 'starting') !== (tracking.finishedAt === null)) {
    throw new InvariantError('tracking finish state is invalid');
  }
  if (tracking.finishedAt !== null && tracking.finishedAt < tracking.startedAt) {
    throw new InvariantError('tracking finishedAt precedes startedAt');
  }
};

export const assertInvestmentConsensusAppend = (
  current: InvestmentConsensus | null,
  next: InvestmentConsensus,
  expectedVersion: number,
  starting: boolean,
): void => {
  assertInvestmentConsensusInvariants(next);
  if ((current?.version ?? 0) !== expectedVersion) {
    throw new InvariantError(
      'consensus_version_conflict: refresh current consensus before confirming',
    );
  }
  if (starting)
    throw new InvariantError('tracking_in_progress: reconcile tracking before revising');
  if (next.version !== expectedVersion + 1 || next.supersedesId !== (current?.id ?? null)) {
    throw new InvariantError('consensus version must append to the current revision');
  }
};

export const assertInvestmentTrackingClaim = (
  current: InvestmentConsensus | null,
  tracking: InvestmentTracking,
  starting: boolean,
): void => {
  assertInvestmentTrackingInvariants(tracking);
  if (current?.version !== tracking.consensusVersion) {
    throw new InvariantError('consensus_version_conflict: refresh before changing tracking');
  }
  if (starting)
    throw new InvariantError('tracking_in_progress: check actual state before retrying');
  if (tracking.status !== 'starting')
    throw new InvariantError('new tracking attempt must be starting');
};
