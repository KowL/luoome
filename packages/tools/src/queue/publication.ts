import {
  AnalysisProvenanceSchema,
  type AnalysisPublication,
  InvestmentDirectionSchema,
  InvestmentEvidenceSchema,
  InvestmentResearchSchema,
  STANDARD_DISCLAIMERS,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';
import {
  defineTool,
  errInvalidInput,
  errLeaseLostBeforeCommit,
  errNotFound,
} from '../define-tool.js';
import {
  ProposeStrategyVersionDraftInput,
  prepareStrategyVersionDraft,
} from '../tools/strategy-definition.js';
import { analysisHash } from './context.js';

export const AnalysisPublicationDraftSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('research_directions'),
    question: z.string().trim().min(1).max(2000),
    directions: z.array(InvestmentDirectionSchema).max(3),
    limitations: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('strategy_version_proposal'),
    proposal: ProposeStrategyVersionDraftInput.omit({ strategyId: true, agentTrace: true }),
  }),
  z.object({
    kind: z.literal('strategy_insight_narrative'),
    actionId: z.string().min(1),
    narrative: z.string().trim().min(1).max(20000),
  }),
]);
export const RecordAnalysisResultInput = z.object({
  contextId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  result: AnalysisPublicationDraftSchema,
  provenance: AnalysisProvenanceSchema.omit({ contextId: true, jobId: true, generatedAt: true }),
  requestId: z.string().min(1).optional(),
});
export const recordAnalysisPublication = async (
  input: z.infer<typeof RecordAnalysisResultInput>,
  ctx: ToolContext,
  claim?: { jobId: string; token: string },
) => {
  const accountId = input.accountId ?? ctx.user.defaultAccountId;
  const context = await ctx.repos.analysis.findContext(accountId, input.contextId);
  if (!context) return errNotFound('AnalysisContext', input.contextId);
  if (
    context.kind !== input.result.kind ||
    context.contextHash !== analysisHash({ facts: context.facts, dataAsOf: context.dataAsOf })
  )
    return errInvalidInput('context_mismatch');
  if (input.provenance.evidenceFactIds.some((id) => !context.factIds.includes(id)))
    return errInvalidInput('unknown_fact_reference');
  const now = ctx.clock();
  const resultHash = analysisHash({ result: input.result, provenance: input.provenance });
  // Replays must not re-run proposal validation against a newer strategy version.
  if (context.recordedResult) {
    if (context.recordedResult.hash !== resultHash) return errInvalidInput('duplicate_result');
    if (context.jobId) {
      const job = await ctx.repos.analysis.findJob(accountId, context.jobId);
      if (
        !claim ||
        claim.jobId !== context.jobId ||
        job?.result?.completedClaimToken !== claim.token
      )
        return errInvalidInput('duplicate_result');
    } else if (claim) return errInvalidInput('context_mismatch');
    return { resultRef: context.recordedResult.ref, replayed: true };
  }
  if (now >= context.writeUntil || now >= context.expiresAt)
    return errInvalidInput('context_expired');
  if (now.getTime() - context.dataAsOf.getTime() > 30 * 60000)
    return errInvalidInput('stale_context');
  const provenance = {
    ...input.provenance,
    contextId: context.id,
    ...(context.jobId ? { jobId: context.jobId } : {}),
    generatedAt: now,
  };
  let publication: AnalysisPublication;
  const result = input.result;
  if (result.kind === 'research_directions') {
    const evidence = context.facts.flatMap((fact) => {
      const parsed = InvestmentEvidenceSchema.safeParse(fact.value);
      return parsed.success && parsed.data.id === fact.id ? [parsed.data] : [];
    });
    publication = {
      kind: result.kind,
      research: InvestmentResearchSchema.parse({
        id: `analysis:${context.id}`,
        ownerUserId: ctx.user.id,
        accountId,
        requestId: `analysis:${context.id}`,
        requestHash: resultHash,
        question: result.question,
        source: { userText: result.question },
        status: result.directions.length ? 'complete' : 'unavailable',
        directions: result.directions,
        evidence,
        limitations: [...context.limitations, ...result.limitations],
        disclaimers: [...STANDARD_DISCLAIMERS],
        createdAt: now,
        provenance,
      }),
    };
  } else if (result.kind === 'strategy_version_proposal') {
    const prepared = await prepareStrategyVersionDraft(
      { ...result.proposal, strategyId: context.subject.id, agentTrace: [] },
      ctx,
    );
    if ('ok' in prepared) return prepared;
    publication = {
      kind: result.kind,
      draft: prepared.draft,
      action: {
        id: `analysis:${context.id}`,
        kind: 'propose-version',
        status: 'drafted',
        strategyId: context.subject.id,
        strategyVersionId: prepared.draft.id,
        trigger: 'weekly-review',
        factReferences: provenance.evidenceFactIds,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        provenance,
      },
    };
  } else {
    const target = context.facts.find((fact) => fact.id === `action:${result.actionId}`);
    const parsed = z
      .object({ id: z.string(), updatedAt: z.coerce.date() })
      .safeParse(target?.value);
    if (!parsed.success || parsed.data.id !== result.actionId)
      return errInvalidInput('context_mismatch');
    publication = {
      kind: result.kind,
      actionId: result.actionId,
      expectedUpdatedAt: parsed.data.updatedAt,
      narrative: result.narrative,
      provenance,
    };
  }
  const recorded = await ctx.repos.analysis.recordPublication({
    accountId,
    contextId: context.id,
    now,
    resultHash,
    publication,
    ...(claim ? { claim } : {}),
  });
  if (recorded.ok) return { resultRef: recorded.resultRef, replayed: recorded.replayed };
  if (recorded.reason === 'lease_lost_before_commit') return errLeaseLostBeforeCommit();
  return errInvalidInput(recorded.reason);
};
export const recordAnalysisResultTool = defineTool({
  name: 'record_analysis_result',
  description: '校验事实与来源后写回研究、策略草案或指定审计动作的叙述；不发布策略。',
  sideEffect: 'queue',
  input: RecordAnalysisResultInput,
  output: z.object({ resultRef: z.string(), replayed: z.boolean() }),
  handler: (input, ctx) => recordAnalysisPublication(input, ctx),
});
