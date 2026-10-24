import { InvariantError } from '../error/index.js';
import type { AnalysisContext } from './analysis-context.js';
import type { AnalysisProvenance } from './analysis-provenance.js';
import {
  assertInvestmentResearchInvariants,
  InvestmentEvidenceSchema,
  type InvestmentResearch,
} from './investment-workspace.js';
import type { StrategyVersion } from './strategy.js';
import {
  assertStrategyAutonomyActionInvariants,
  type StrategyAutonomyAction,
} from './strategy-autonomy-action.js';

export type AnalysisPublication =
  | { readonly kind: 'research_directions'; readonly research: InvestmentResearch }
  | {
      readonly kind: 'strategy_version_proposal';
      readonly action: StrategyAutonomyAction;
      readonly draft: StrategyVersion;
    }
  | {
      readonly kind: 'strategy_insight_narrative';
      readonly actionId: string;
      readonly expectedUpdatedAt: Date;
      readonly narrative: string;
      readonly provenance: AnalysisProvenance;
    };

export const analysisPublicationRef = (value: AnalysisPublication): string =>
  value.kind === 'research_directions'
    ? value.research.id
    : value.kind === 'strategy_version_proposal'
      ? value.action.id
      : value.actionId;

export const assertAnalysisPublication = (
  context: AnalysisContext,
  value: AnalysisPublication,
): void => {
  const provenance =
    value.kind === 'research_directions'
      ? value.research.provenance
      : value.kind === 'strategy_version_proposal'
        ? value.action.provenance
        : value.provenance;
  if (
    value.kind !== context.kind ||
    provenance?.contextId !== context.id ||
    provenance.jobId !== (context.jobId ?? undefined) ||
    provenance.evidenceFactIds.some((id) => !context.factIds.includes(id))
  )
    throw new InvariantError('context_mismatch');
  if (value.kind === 'research_directions') {
    assertInvestmentResearchInvariants(value.research);
    for (const evidence of value.research.evidence) {
      const snapshot = InvestmentEvidenceSchema.safeParse(
        context.facts.find((fact) => fact.id === evidence.id)?.value,
      );
      if (
        !snapshot.success ||
        JSON.stringify(snapshot.data) !== JSON.stringify(InvestmentEvidenceSchema.parse(evidence))
      )
        throw new InvariantError('context_evidence_mismatch');
    }
    if (
      value.research.directions.some(
        (direction) =>
          direction.dataAsOf.getTime() !== context.dataAsOf.getTime() ||
          direction.evidenceIds.some((id) => !provenance.evidenceFactIds.includes(id)),
      )
    )
      throw new InvariantError('context_evidence_mismatch');

    if (
      value.research.accountId !== context.accountId ||
      value.research.id !== `analysis:${context.id}`
    )
      throw new InvariantError('context_mismatch');
  } else if (value.kind === 'strategy_version_proposal') {
    assertStrategyAutonomyActionInvariants(value.action);
    if (value.draft.factReferences?.some((id) => !context.factIds.includes(id)))
      throw new InvariantError('context_evidence_mismatch');
    if (
      value.action.id !== `analysis:${context.id}` ||
      value.action.kind !== 'propose-version' ||
      value.action.status !== 'drafted' ||
      value.action.strategyId !== context.subject.id ||
      value.draft.strategyId !== context.subject.id ||
      value.action.strategyVersionId !== value.draft.id ||
      value.draft.validationStatus !== 'pending' ||
      value.draft.publishedAt !== undefined
    )
      throw new InvariantError('context_mismatch');
  } else if (!value.narrative.trim()) throw new InvariantError('empty_narrative');
};
