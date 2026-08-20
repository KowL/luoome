import { z } from 'zod';

const modelPart = z.string().trim().min(1).max(200);

export const ResearchEmbeddingModelIdentitySchema = z.object({
  provider: modelPart,
  model: modelPart,
  dimensions: z.number().int().positive().max(65_536),
  version: modelPart,
});
export type ResearchEmbeddingModelIdentity = z.infer<typeof ResearchEmbeddingModelIdentitySchema>;

export const researchEmbeddingIdentityKey = (identity: ResearchEmbeddingModelIdentity): string =>
  JSON.stringify([identity.provider, identity.model, identity.dimensions, identity.version]);

export const ResearchChunkEmbeddingSchema = z
  .object({
    documentId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    identity: ResearchEmbeddingModelIdentitySchema,
    vector: z.array(z.number().finite()).min(1).max(65_536),
    embeddedAt: z.coerce.date(),
  })
  .superRefine((value, ctx) => {
    if (value.vector.length !== value.identity.dimensions) {
      ctx.addIssue({
        code: 'custom',
        path: ['vector'],
        message: `vector length must equal identity dimensions (${value.identity.dimensions})`,
      });
    }
  });
export type ResearchChunkEmbedding = z.infer<typeof ResearchChunkEmbeddingSchema>;

export const ResearchEmbeddingIndexStateSchema = z.object({
  identity: ResearchEmbeddingModelIdentitySchema,
  status: z.enum(['empty', 'building', 'ready', 'partial', 'failed', 'stale']),
  expectedChunks: z.number().int().nonnegative(),
  embeddedChunks: z.number().int().nonnegative(),
  staleChunks: z.number().int().nonnegative(),
  updatedAt: z.coerce.date(),
  diagnostic: z.string().max(500).optional(),
});
export type ResearchEmbeddingIndexState = z.infer<typeof ResearchEmbeddingIndexStateSchema>;

export const ResearchEmbeddingUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  latencyMs: z.number().nonnegative(),
});
export type ResearchEmbeddingUsage = z.infer<typeof ResearchEmbeddingUsageSchema>;
