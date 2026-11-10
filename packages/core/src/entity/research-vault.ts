import { z } from 'zod';

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
export const ResearchContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const hashSchema = ResearchContentHashSchema;
const tagsSchema = z.array(z.string().min(1).max(64)).max(32);
const stockCodesSchema = z.array(z.string().trim().min(1).max(32)).max(200);

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
  /** 文档显式关联的股票代码；替代原 research_subject_links 表。 */
  stockCodes: stockCodesSchema.default([]),
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

export const researchDocumentDate = (document: ResearchDocumentIndex): Date =>
  document.observedAt ?? document.publishedAt ?? document.importedAt;
