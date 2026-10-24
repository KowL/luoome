import { z } from 'zod';
import { InvariantError } from '../error/index.js';
import { AnalysisKindSchema, AnalysisSubjectSchema, analysisSubjectKinds } from './analysis-job.js';

export const AnalysisContextSchema = z
  .object({
    recordedResult: z.object({ hash: z.string().min(1), ref: z.string().min(1) }).optional(),
    id: z.string().min(1),
    jobId: z.string().min(1).nullable(),
    kind: AnalysisKindSchema,
    accountId: z.string().min(1),
    subject: AnalysisSubjectSchema,
    dataAsOf: z.coerce.date(),
    facts: z.array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        value: z.json(),
        evidenceIds: z.array(z.string().min(1)),
      }),
    ),
    factIds: z.array(z.string().min(1)),
    limitations: z.array(z.string().min(1)),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/),
    writeUntil: z.coerce.date(),
    expiresAt: z.coerce.date(),
    createdAt: z.coerce.date(),
  })
  .superRefine((context, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (analysisSubjectKinds[context.kind] !== context.subject.kind)
      invalid('analysis_subject_mismatch');
    const ids = new Set(context.factIds);
    if (
      ids.size !== context.factIds.length ||
      context.facts.length !== ids.size ||
      new Set(context.facts.map((fact) => fact.id)).size !== ids.size ||
      context.facts.some((fact) => !ids.has(fact.id))
    )
      invalid('analysis_fact_ids_mismatch');
    if (
      context.dataAsOf > context.createdAt ||
      context.expiresAt < context.createdAt ||
      context.writeUntil > context.expiresAt
    )
      invalid('analysis_context_time_order_invalid');
  });
export type AnalysisContext = z.infer<typeof AnalysisContextSchema>;
export const assertAnalysisContextInvariants = (context: AnalysisContext): void => {
  const result = AnalysisContextSchema.safeParse(context);
  if (!result.success) throw new InvariantError(result.error.message);
};

export const analysisContextWriteError = (
  context: AnalysisContext,
  now: Date,
  evidenceFactIds: readonly string[],
): 'context_expired' | 'unknown_fact_reference' | undefined => {
  if (now >= context.writeUntil || now >= context.expiresAt) return 'context_expired';
  const facts = new Set(context.factIds);
  if (evidenceFactIds.some((id) => !facts.has(id))) return 'unknown_fact_reference';
  return undefined;
};

export const analysisAdviceContextError = (
  context: AnalysisContext,
  advice: import('./advice.js').Advice,
): 'context_mismatch' | undefined => {
  if (
    !context.kind.startsWith('advice_') ||
    advice.id !== `analysis:${context.id}` ||
    advice.provenance?.contextId !== context.id ||
    advice.provenance.jobId !== (context.jobId ?? undefined) ||
    advice.basedOn.dataAsOf.getTime() !== context.dataAsOf.getTime() ||
    advice.subjectId !== context.subject.id ||
    advice.subjectKind !==
      (context.subject.kind === 'stock'
        ? 'stock'
        : context.subject.kind === 'position'
          ? 'position'
          : 'market') ||
    advice.provenance.evidenceFactIds.some((id) => !context.factIds.includes(id))
  )
    return 'context_mismatch';
  return undefined;
};
