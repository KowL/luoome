import type {
  ResearchChunkEmbedding,
  ResearchEmbeddingIndexState,
  ResearchEmbeddingModelIdentity,
  ResearchEmbeddingRepository,
  ResearchIndexRepository,
  ResearchSearchHit,
} from '@luoome/core';
import { researchEmbeddingIdentityKey } from '@luoome/core';

const copy = <T>(value: T): T => structuredClone(value);
const rowKey = (
  identity: ResearchEmbeddingModelIdentity,
  documentId: string,
  ordinal: number,
): string => `${researchEmbeddingIdentityKey(identity)}\u0000${documentId}\u0000${ordinal}`;

const cosine = (left: readonly number[], right: readonly number[]): number => {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
};

export class InMemoryResearchEmbeddingRepository implements ResearchEmbeddingRepository {
  private readonly embeddings = new Map<string, ResearchChunkEmbedding>();
  private readonly states = new Map<string, ResearchEmbeddingIndexState>();

  constructor(private readonly researchIndex: ResearchIndexRepository) {}

  async listPending(
    input: Parameters<ResearchEmbeddingRepository['listPending']>[0],
  ): Promise<Awaited<ReturnType<ResearchEmbeddingRepository['listPending']>>> {
    const chunks = await this.allChunks();
    return chunks
      .filter((chunk) => {
        const current = this.embeddings.get(
          rowKey(input.identity, chunk.documentId, chunk.ordinal),
        );
        return current === undefined || current.contentHash !== chunk.contentHash;
      })
      .slice(0, input.limit)
      .map(copy);
  }

  async saveMany(embeddings: readonly ResearchChunkEmbedding[]): Promise<void> {
    for (const embedding of embeddings) {
      this.embeddings.set(
        rowKey(embedding.identity, embedding.documentId, embedding.ordinal),
        copy(embedding),
      );
    }
  }

  async deleteInvalid(identity: ResearchEmbeddingModelIdentity): Promise<number> {
    const valid = new Map(
      (await this.allChunks()).map((chunk) => [`${chunk.documentId}\u0000${chunk.ordinal}`, chunk]),
    );
    let deleted = 0;
    const prefix = `${researchEmbeddingIdentityKey(identity)}\u0000`;
    for (const [key, embedding] of this.embeddings) {
      if (!key.startsWith(prefix)) continue;
      const chunk = valid.get(`${embedding.documentId}\u0000${embedding.ordinal}`);
      if (chunk !== undefined && chunk.contentHash === embedding.contentHash) continue;
      this.embeddings.delete(key);
      deleted++;
    }
    return deleted;
  }

  async inspect(
    identity: ResearchEmbeddingModelIdentity,
    now: Date,
  ): Promise<ResearchEmbeddingIndexState> {
    const chunks = await this.allChunks();
    let embeddedChunks = 0;
    for (const chunk of chunks) {
      const embedding = this.embeddings.get(rowKey(identity, chunk.documentId, chunk.ordinal));
      if (embedding?.contentHash === chunk.contentHash) embeddedChunks++;
    }
    const staleChunks = chunks.length - embeddedChunks;
    const saved = this.states.get(researchEmbeddingIdentityKey(identity));
    const status =
      chunks.length === 0
        ? 'empty'
        : staleChunks > 0
          ? embeddedChunks > 0
            ? 'partial'
            : saved?.status === 'failed'
              ? 'failed'
              : 'stale'
          : 'ready';
    const savedMatchesProjection =
      saved?.status === status &&
      saved.expectedChunks === chunks.length &&
      saved.embeddedChunks === embeddedChunks &&
      saved.staleChunks === staleChunks;
    return {
      identity: copy(identity),
      status,
      expectedChunks: chunks.length,
      embeddedChunks,
      staleChunks,
      updatedAt: savedMatchesProjection ? saved.updatedAt : now,
      ...(savedMatchesProjection && saved.diagnostic !== undefined
        ? { diagnostic: saved.diagnostic }
        : {}),
    };
  }

  async saveState(state: ResearchEmbeddingIndexState): Promise<void> {
    this.states.set(researchEmbeddingIdentityKey(state.identity), copy(state));
  }

  async findState(
    identity: ResearchEmbeddingModelIdentity,
  ): Promise<ResearchEmbeddingIndexState | null> {
    const state = this.states.get(researchEmbeddingIdentityKey(identity));
    return state === undefined ? null : copy(state);
  }

  async searchSimilar(
    input: Parameters<ResearchEmbeddingRepository['searchSimilar']>[0],
  ): Promise<readonly ResearchSearchHit[]> {
    if (input.vector.length !== input.identity.dimensions) return [];
    const allowedDocuments = await this.researchIndex.listDocuments({
      ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      limit: Number.MAX_SAFE_INTEGER,
    });
    const documents = new Map(allowedDocuments.map((document) => [document.id, document]));
    const chunks = new Map(
      (await this.allChunks()).map((chunk) => [`${chunk.documentId}\u0000${chunk.ordinal}`, chunk]),
    );
    const prefix = `${researchEmbeddingIdentityKey(input.identity)}\u0000`;
    return [...this.embeddings.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([, embedding]) => {
        const document = documents.get(embedding.documentId);
        const chunk = chunks.get(`${embedding.documentId}\u0000${embedding.ordinal}`);
        if (
          document === undefined ||
          chunk === undefined ||
          chunk.contentHash !== embedding.contentHash
        ) {
          return [];
        }
        return [
          {
            document: copy(document),
            ordinal: chunk.ordinal,
            headingPath: chunk.headingPath,
            snippet: chunk.body.slice(0, 500),
            score: cosine(input.vector, embedding.vector),
          },
        ];
      })
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, input.limit);
  }

  private async allChunks() {
    return this.researchIndex.listChunks();
  }
}
