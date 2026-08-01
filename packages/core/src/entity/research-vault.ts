import { z } from 'zod';
import { InvariantError } from '../error/index.js';

export const ResearchTopicKindSchema = z.enum([
  'company',
  'industry',
  'event',
  'theme',
  'macro',
  'custom',
]);
export type ResearchTopicKind = z.infer<typeof ResearchTopicKindSchema>;
export const ResearchDocumentKindSchema = z.enum([
  'report',
  'article',
  'filing',
  'transcript',
  'note',
  'thesis',
  'analysis',
  'timeline-update',
]);
export type ResearchDocumentKind = z.infer<typeof ResearchDocumentKindSchema>;
export const ResearchAvailabilitySchema = z.enum(['available', 'missing', 'invalid', 'conflict']);
export type ResearchAvailability = z.infer<typeof ResearchAvailabilitySchema>;
export const ResearchSubjectKindSchema = z.enum([
  'stock',
  'industry',
  'stock-event',
  'theme',
  'macro',
]);
export type ResearchSubjectKind = z.infer<typeof ResearchSubjectKindSchema>;
export const ResearchSubjectRelationSchema = z.enum([
  'primary',
  'related',
  'mentioned',
  'evidence',
]);
export type ResearchSubjectRelation = z.infer<typeof ResearchSubjectRelationSchema>;

const pathSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (value.includes('\\')) return false;
    const normalized = value.replaceAll('\\', '/');
    return (
      !normalized.startsWith('/') &&
      !/^[A-Za-z]:/.test(normalized) &&
      !normalized.includes('\0') &&
      !normalized.split('/').includes('..')
    );
  }, 'must be a safe POSIX relative path');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const tagsSchema = z.array(z.string().min(1).max(64)).max(32);

export const ResearchTopicIndexSchema = z.object({
  id: z.string().regex(/^topic_[A-Za-z0-9_-]+$/),
  title: z.string().min(1).max(200),
  kind: ResearchTopicKindSchema,
  summary: z.string().max(1000).optional(),
  tags: tagsSchema,
  vaultId: z.string().min(1),
  relativePath: pathSchema,
  contentHash: hashSchema,
  archivedAt: z.coerce.date().optional(),
  fileModifiedAt: z.coerce.date(),
  indexedAt: z.coerce.date(),
  availability: ResearchAvailabilitySchema,
  diagnostic: z.string().max(300).optional(),
});
export type ResearchTopicIndex = z.infer<typeof ResearchTopicIndexSchema>;

export const ResearchDocumentIndexSchema = z.object({
  id: z.string().regex(/^doc_[A-Za-z0-9_-]+$/),
  kind: ResearchDocumentKindSchema,
  title: z.string().min(1).max(300),
  author: z.string().max(200).optional(),
  sourceUrl: z.string().url().optional(),
  sourceStatus: z.enum(['verified', 'unverified']).optional(),
  publishedAt: z.coerce.date().optional(),
  observedAt: z.coerce.date().optional(),
  importedAt: z.coerce.date(),
  tags: tagsSchema,
  vaultId: z.string().min(1),
  relativePath: pathSchema,
  attachmentPaths: z.array(pathSchema).max(64),
  contentHash: hashSchema,
  excerpt: z.string().max(1000).optional(),
  fileModifiedAt: z.coerce.date(),
  indexedAt: z.coerce.date(),
  availability: ResearchAvailabilitySchema,
  diagnostic: z.string().max(300).optional(),
});
export type ResearchDocumentIndex = z.infer<typeof ResearchDocumentIndexSchema>;

export const ResearchSubjectLinkSchema = z.object({
  ownerKind: z.enum(['topic', 'document']),
  ownerId: z.string().min(1),
  subjectKind: ResearchSubjectKindSchema,
  subjectKey: z.string().trim().min(1).max(200),
  relation: ResearchSubjectRelationSchema,
});
export type ResearchSubjectLink = z.infer<typeof ResearchSubjectLinkSchema>;
export const ResearchTopicDocumentSchema = z.object({
  topicId: z.string().min(1),
  documentId: z.string().min(1),
  relation: z.enum(['primary', 'supporting', 'counter-evidence', 'update']),
  order: z.number().int().nonnegative().optional(),
});
export type ResearchTopicDocument = z.infer<typeof ResearchTopicDocumentSchema>;
export const ResearchDocumentChunkSchema = z.object({
  documentId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  headingPath: z.string(),
  contentHash: hashSchema,
  body: z.string().min(1).max(2500),
});
export type ResearchDocumentChunk = z.infer<typeof ResearchDocumentChunkSchema>;
export const ResearchVaultSyncRunSchema = z.object({
  id: z.string().min(1),
  vaultId: z.string().min(1),
  mode: z.enum(['manual', 'scheduled']),
  status: z.enum(['running', 'succeeded', 'partial', 'failed']),
  scanned: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().optional(),
  error: z.string().max(500).optional(),
});
export type ResearchVaultSyncRun = z.infer<typeof ResearchVaultSyncRunSchema>;

export const normalizeResearchSubject = (
  value: string,
): { kind: ResearchSubjectKind; key: string } => {
  const split = value.indexOf(':');
  if (split <= 0) throw new InvariantError(`研究对象格式无效: ${value}`);
  const kind = ResearchSubjectKindSchema.parse(value.slice(0, split));
  const key = value
    .slice(split + 1)
    .normalize('NFC')
    .trim();
  if (!key) throw new InvariantError(`研究对象 key 为空: ${value}`);
  return { kind, key };
};

export const researchDocumentDate = (document: ResearchDocumentIndex): Date =>
  document.observedAt ?? document.publishedAt ?? document.importedAt;
