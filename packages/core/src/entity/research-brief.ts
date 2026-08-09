import { z } from 'zod';

/** ResearchBrief 的证据类型；引用必须落到已有的持久化事实或索引 chunk。 */
export const ResearchEvidenceKindSchema = z.enum([
  'document-chunk',
  'stock-event',
  'strategy-signal',
  'watch-trigger',
  'advice',
]);
export type ResearchEvidenceKind = z.infer<typeof ResearchEvidenceKindSchema>;

const evidenceRefBase = z.object({
  kind: ResearchEvidenceKindSchema,
  id: z.string().min(1).max(300),
  documentId: z.string().min(1).optional(),
  ordinal: z.number().int().nonnegative().optional(),
  relativePath: z.string().min(1).max(1000).optional(),
  headingPath: z.string().max(500).optional(),
  /** quote 来自索引 chunk，不能承载超过 500 字符的整段正文。 */
  quote: z.string().min(1).max(500).optional(),
  occurredAt: z.coerce.date().optional(),
});

export const EvidenceRefSchema = evidenceRefBase.superRefine((ref, ctx) => {
  if (ref.kind !== 'document-chunk') return;
  if (ref.documentId === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['documentId'],
      message: 'Document chunk 必须有 documentId',
    });
  }
  if (ref.ordinal === undefined) {
    ctx.addIssue({ code: 'custom', path: ['ordinal'], message: 'Document chunk 必须有 ordinal' });
  }
  if (ref.relativePath === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['relativePath'],
      message: 'Document chunk 必须有 relativePath',
    });
  }
  if (ref.quote === undefined) {
    ctx.addIssue({ code: 'custom', path: ['quote'], message: 'Document chunk 必须有 quote' });
  }
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ResearchBriefSourceStatusSchema = z.enum([
  'verified',
  'unverified',
  'mixed',
  'unavailable',
]);
export type ResearchBriefSourceStatus = z.infer<typeof ResearchBriefSourceStatusSchema>;

export const ResearchBriefSchema = z.object({
  scope: z.string().min(1).max(500),
  conclusion: z.string().min(1).max(2000),
  facts: z.array(EvidenceRefSchema).max(50),
  inferences: z.array(z.string().min(1).max(1000)).max(20),
  counterEvidence: z.array(EvidenceRefSchema).max(50),
  risks: z.array(z.string().min(1).max(1000)).max(20),
  unknowns: z.array(z.string().min(1).max(1000)).max(20),
  dataAsOf: z.coerce.date(),
  sourceStatus: ResearchBriefSourceStatusSchema,
  suggestedFollowUps: z.array(z.string().min(1).max(500)).max(20),
});
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>;
