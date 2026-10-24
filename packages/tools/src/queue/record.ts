import {
  type Advice,
  AdviceSchema,
  AnalysisProvenanceSchema,
  addTradingDays,
  adviceExpiryDays,
  dateInShanghai,
  STANDARD_DISCLAIMERS,
  StrategyAdviceAnalysisSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';
import {
  defineTool,
  errInvalidInput,
  errLeaseLostBeforeCommit,
  errNotFound,
} from '../define-tool.js';
import { sanitizeAdviceReasoning, sanitizeAdviceRisks } from '../internal/sanitize-advice.js';
import { analysisHash } from './context.js';
import { AnalysisPublicationDraftSchema, recordAnalysisPublication } from './publication.js';

export const RecordAdviceInput = z.object({
  contextId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  result: StrategyAdviceAnalysisSchema,
  provenance: AnalysisProvenanceSchema.omit({ contextId: true, jobId: true, generatedAt: true }),
  requestId: z.string().min(1).optional(),
});

const recordAdvice = async (
  input: z.infer<typeof RecordAdviceInput>,
  ctx: ToolContext,
  claim?: { jobId: string; token: string },
) => {
  const accountId = input.accountId ?? ctx.user.defaultAccountId;
  const context = await ctx.repos.analysis.findContext(accountId, input.contextId);
  if (!context) return errNotFound('AnalysisContext', input.contextId);
  if (!context.kind.startsWith('advice_')) return errInvalidInput('context_mismatch');
  if (context.contextHash !== analysisHash({ facts: context.facts, dataAsOf: context.dataAsOf }))
    return errInvalidInput('context_mismatch');
  if (input.provenance.evidenceFactIds.some((id) => !context.factIds.includes(id)))
    return errInvalidInput('unknown_fact_reference');
  const now = ctx.clock();
  if (!context.recordedResult) {
    if (now >= context.writeUntil || now >= context.expiresAt)
      return errInvalidInput('context_expired');
    if (now.getTime() - context.dataAsOf.getTime() > 30 * 60000)
      return errInvalidInput('stale_context');
  }
  const advice = AdviceSchema.parse({
    ...input.result,
    reasoning: sanitizeAdviceReasoning(input.result.reasoning),
    risks: sanitizeAdviceRisks(input.result.risks),
    id: `analysis:${context.id}`,
    subjectKind: context.subject.kind,
    subjectId: context.subject.id,
    basedOn: { dataAsOf: context.dataAsOf },
    disclaimers: [...STANDARD_DISCLAIMERS],
    sourceTool: claim ? 'complete_analysis_job' : 'record_advice',
    validFrom: now,
    validUntil:
      input.result.horizon === 'intraday'
        ? new Date(`${dateInShanghai(now)}T15:00:00+08:00`)
        : addTradingDays(now, adviceExpiryDays[input.result.horizon]),
    createdAt: now,
    provenance: {
      ...input.provenance,
      contextId: context.id,
      ...(context.jobId ? { jobId: context.jobId } : {}),
      generatedAt: now,
    },
  });
  const recorded = await ctx.repos.analysis.recordAdvice({
    accountId,
    contextId: context.id,
    advice: advice as Advice,
    now,
    resultHash: analysisHash({ result: input.result, provenance: input.provenance }),
    ...(claim ? { claim } : {}),
  });
  if (recorded.ok) return AdviceSchema.parse(recorded.advice);
  if (recorded.reason === 'lease_lost_before_commit') return errLeaseLostBeforeCommit();
  if (recorded.reason === 'not_found') return errNotFound('AnalysisContext', context.id);
  return errInvalidInput(recorded.reason);
};

export const recordAdviceTool = defineTool({
  name: 'record_advice',
  description: '校验事实引用和投资建议不变量后写回，标准免责声明与有效期由领域确定。',
  sideEffect: 'queue',
  input: RecordAdviceInput,
  output: AdviceSchema,
  handler: (input, ctx) => recordAdvice(input, ctx),
});
export const completeAnalysisJobTool = defineTool({
  name: 'complete_analysis_job',
  description: '持有有效租约的消费者原子写回分析结果并完成任务。',
  sideEffect: 'queue',
  input: RecordAdviceInput.omit({ contextId: true }).extend({
    result: z.union([StrategyAdviceAnalysisSchema, AnalysisPublicationDraftSchema]),
    jobId: z.string().min(1),
    claimToken: z.string().min(1),
  }),
  output: z.object({ jobId: z.string(), status: z.literal('completed'), resultRef: z.string() }),
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const job = await ctx.repos.analysis.findJob(accountId, input.jobId);
    if (!job) return errNotFound('AnalysisJob', input.jobId);
    if (!job.contextId) return errLeaseLostBeforeCommit();
    const claim = { jobId: job.id, token: input.claimToken };
    if ('kind' in input.result) {
      const result = await recordAnalysisPublication(
        { ...input, result: input.result, contextId: job.contextId },
        ctx,
        claim,
      );
      if ('ok' in result) return result;
      return { jobId: job.id, status: 'completed' as const, resultRef: result.resultRef };
    }
    const result = await recordAdvice(
      { ...input, result: input.result, contextId: job.contextId },
      ctx,
      claim,
    );
    if ('ok' in result) return result;
    return { jobId: job.id, status: 'completed' as const, resultRef: result.id };
  },
});
