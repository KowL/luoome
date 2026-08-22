import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { ResearchContentHashSchema } from './research-vault.js';

export const ResearchHypothesisVersionStatusSchema = z.enum(['active', 'superseded', 'archived']);
export type ResearchHypothesisVersionStatus = z.infer<typeof ResearchHypothesisVersionStatusSchema>;

/**
 * Topic 级研究假设版本元数据。正文仍由 ResearchDocument/Vault 维护；这里仅保存
 * 可审计的不可变引用、版本链和生命周期状态。
 */
export const ResearchHypothesisVersionSchema = z.object({
  id: z.string().regex(/^hypothesis_[A-Za-z0-9_-]+$/),
  topicId: z.string().regex(/^topic_[A-Za-z0-9_-]+$/),
  documentId: z.string().regex(/^doc_[A-Za-z0-9_-]+$/),
  documentContentHash: ResearchContentHashSchema,
  version: z.number().int().positive(),
  status: ResearchHypothesisVersionStatusSchema,
  supersedesId: z
    .string()
    .regex(/^hypothesis_[A-Za-z0-9_-]+$/)
    .optional(),
  summary: z.string().trim().min(1).max(2000).optional(),
  createdAt: z.coerce.date(),
});
export type ResearchHypothesisVersion = z.infer<typeof ResearchHypothesisVersionSchema>;

export const assertResearchHypothesisVersionInvariants = (
  version: ResearchHypothesisVersion,
): void => {
  ResearchHypothesisVersionSchema.parse(version);
  if (version.supersedesId === version.id) {
    throw new InvariantError('ResearchHypothesisVersion.supersedesId 不能指向自身');
  }
  if (version.version === 1 && version.supersedesId !== undefined) {
    throw new InvariantError('ResearchHypothesisVersion.version=1 不得有 supersedesId');
  }
  if (version.version > 1 && version.supersedesId === undefined) {
    throw new InvariantError('ResearchHypothesisVersion.version>1 必须有 supersedesId');
  }
};
