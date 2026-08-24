import { describe, expect, it } from 'vitest';

import {
  ResearchChunkEmbeddingSchema,
  researchEmbeddingIdentityKey,
} from './research-embedding.js';

describe('Research embedding domain', () => {
  it('模型 identity key 无分隔符碰撞', () => {
    const left = researchEmbeddingIdentityKey({
      provider: 'a:b',
      model: 'c',
      dimensions: 3,
      version: 'v1',
    });
    const right = researchEmbeddingIdentityKey({
      provider: 'a',
      model: 'b:c',
      dimensions: 3,
      version: 'v1',
    });
    expect(left).not.toBe(right);
  });

  it('向量长度必须等于 identity dimensions', () => {
    const result = ResearchChunkEmbeddingSchema.safeParse({
      documentId: 'doc-1',
      ordinal: 0,
      contentHash: 'a'.repeat(64),
      identity: { provider: 'fixture', model: 'small', dimensions: 3, version: 'v1' },
      vector: [1, 0],
      embeddedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });
});
