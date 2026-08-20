import type {
  ResearchChunkEmbedding,
  ResearchDocumentIndex,
  ResearchEmbeddingIndexState,
  ResearchEmbeddingModelIdentity,
  ResearchEmbeddingRepository,
  ResearchSearchHit,
} from '@luoome/core';
import { researchEmbeddingIdentityKey } from '@luoome/core';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { DrizzleDb } from '../../client.js';
import {
  researchChunkEmbeddings,
  researchDocumentChunks,
  researchDocumentIndex,
  researchEmbeddingIndexStates,
  researchSubjectLinks,
  researchTopicDocuments,
} from '../../schema/index.js';

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

const documentFrom = (row: typeof researchDocumentIndex.$inferSelect): ResearchDocumentIndex => ({
  ...row,
  tags: [...(row.tags ?? [])],
  attachmentPaths: [...(row.attachmentPaths ?? [])],
  author: row.author ?? undefined,
  sourceUrl: row.sourceUrl ?? undefined,
  sourceStatus: (row.sourceStatus as ResearchDocumentIndex['sourceStatus']) ?? undefined,
  publishedAt: row.publishedAt ?? undefined,
  observedAt: row.observedAt ?? undefined,
  excerpt: row.excerpt ?? undefined,
  diagnostic: row.diagnostic ?? undefined,
  kind: row.kind as ResearchDocumentIndex['kind'],
  availability: row.availability as ResearchDocumentIndex['availability'],
});

export class DrizzleResearchEmbeddingRepository implements ResearchEmbeddingRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listPending(
    input: Parameters<ResearchEmbeddingRepository['listPending']>[0],
  ): Promise<Awaited<ReturnType<ResearchEmbeddingRepository['listPending']>>> {
    const identityKey = researchEmbeddingIdentityKey(input.identity);
    const rows = this.db
      .select({ chunk: researchDocumentChunks, embedding: researchChunkEmbeddings })
      .from(researchDocumentChunks)
      .leftJoin(
        researchChunkEmbeddings,
        and(
          eq(researchChunkEmbeddings.identityKey, identityKey),
          eq(researchChunkEmbeddings.documentId, researchDocumentChunks.documentId),
          eq(researchChunkEmbeddings.ordinal, researchDocumentChunks.ordinal),
        ),
      )
      .orderBy(asc(researchDocumentChunks.documentId), asc(researchDocumentChunks.ordinal))
      .all();
    return rows
      .filter(
        ({ chunk, embedding }) => embedding === null || embedding.contentHash !== chunk.contentHash,
      )
      .slice(0, input.limit)
      .map(({ chunk }) => chunk);
  }

  async saveMany(embeddings: readonly ResearchChunkEmbedding[]): Promise<void> {
    if (embeddings.length === 0) return;
    this.db.transaction((tx) => {
      for (const embedding of embeddings) {
        const row: typeof researchChunkEmbeddings.$inferInsert = {
          documentId: embedding.documentId,
          ordinal: embedding.ordinal,
          contentHash: embedding.contentHash,
          identityKey: researchEmbeddingIdentityKey(embedding.identity),
          provider: embedding.identity.provider,
          model: embedding.identity.model,
          dimensions: embedding.identity.dimensions,
          version: embedding.identity.version,
          vector: [...embedding.vector],
          embeddedAt: embedding.embeddedAt,
        };
        tx.insert(researchChunkEmbeddings)
          .values(row)
          .onConflictDoUpdate({
            target: [
              researchChunkEmbeddings.identityKey,
              researchChunkEmbeddings.documentId,
              researchChunkEmbeddings.ordinal,
            ],
            set: row,
          })
          .run();
      }
    });
  }

  async deleteInvalid(identity: ResearchEmbeddingModelIdentity): Promise<number> {
    const identityKey = researchEmbeddingIdentityKey(identity);
    const valid = new Map(
      this.db
        .select()
        .from(researchDocumentChunks)
        .all()
        .map((chunk) => [`${chunk.documentId}\u0000${chunk.ordinal}`, chunk]),
    );
    const invalid = this.db
      .select()
      .from(researchChunkEmbeddings)
      .where(eq(researchChunkEmbeddings.identityKey, identityKey))
      .all()
      .filter((embedding) => {
        const chunk = valid.get(`${embedding.documentId}\u0000${embedding.ordinal}`);
        return chunk === undefined || chunk.contentHash !== embedding.contentHash;
      });
    this.db.transaction((tx) => {
      for (const embedding of invalid) {
        tx.delete(researchChunkEmbeddings)
          .where(
            and(
              eq(researchChunkEmbeddings.identityKey, identityKey),
              eq(researchChunkEmbeddings.documentId, embedding.documentId),
              eq(researchChunkEmbeddings.ordinal, embedding.ordinal),
            ),
          )
          .run();
      }
    });
    return invalid.length;
  }

  async inspect(
    identity: ResearchEmbeddingModelIdentity,
    now: Date,
  ): Promise<ResearchEmbeddingIndexState> {
    const identityKey = researchEmbeddingIdentityKey(identity);
    const chunks = this.db.select().from(researchDocumentChunks).all();
    const embeddings = new Map(
      this.db
        .select()
        .from(researchChunkEmbeddings)
        .where(eq(researchChunkEmbeddings.identityKey, identityKey))
        .all()
        .map((embedding) => [`${embedding.documentId}\u0000${embedding.ordinal}`, embedding]),
    );
    const embeddedChunks = chunks.filter(
      (chunk) =>
        embeddings.get(`${chunk.documentId}\u0000${chunk.ordinal}`)?.contentHash ===
        chunk.contentHash,
    ).length;
    const staleChunks = chunks.length - embeddedChunks;
    const saved = await this.findState(identity);
    const status =
      chunks.length === 0
        ? 'empty'
        : staleChunks === 0
          ? 'ready'
          : embeddedChunks > 0
            ? 'partial'
            : saved?.status === 'failed'
              ? 'failed'
              : 'stale';
    const savedMatchesProjection =
      saved?.status === status &&
      saved.expectedChunks === chunks.length &&
      saved.embeddedChunks === embeddedChunks &&
      saved.staleChunks === staleChunks;
    return {
      identity,
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
    const row: typeof researchEmbeddingIndexStates.$inferInsert = {
      identityKey: researchEmbeddingIdentityKey(state.identity),
      provider: state.identity.provider,
      model: state.identity.model,
      dimensions: state.identity.dimensions,
      version: state.identity.version,
      status: state.status,
      expectedChunks: state.expectedChunks,
      embeddedChunks: state.embeddedChunks,
      staleChunks: state.staleChunks,
      updatedAt: state.updatedAt,
      diagnostic: state.diagnostic ?? null,
    };
    this.db
      .insert(researchEmbeddingIndexStates)
      .values(row)
      .onConflictDoUpdate({ target: researchEmbeddingIndexStates.identityKey, set: row })
      .run();
  }

  async findState(
    identity: ResearchEmbeddingModelIdentity,
  ): Promise<ResearchEmbeddingIndexState | null> {
    const row = this.db
      .select()
      .from(researchEmbeddingIndexStates)
      .where(eq(researchEmbeddingIndexStates.identityKey, researchEmbeddingIdentityKey(identity)))
      .get();
    return row === undefined
      ? null
      : {
          identity: {
            provider: row.provider,
            model: row.model,
            dimensions: row.dimensions,
            version: row.version,
          },
          status: row.status,
          expectedChunks: row.expectedChunks,
          embeddedChunks: row.embeddedChunks,
          staleChunks: row.staleChunks,
          updatedAt: row.updatedAt,
          ...(row.diagnostic === null ? {} : { diagnostic: row.diagnostic }),
        };
  }

  async searchSimilar(
    input: Parameters<ResearchEmbeddingRepository['searchSimilar']>[0],
  ): Promise<readonly ResearchSearchHit[]> {
    if (input.vector.length !== input.identity.dimensions) return [];
    let allowed = this.db.select().from(researchDocumentIndex).all();
    if (input.kind !== undefined)
      allowed = allowed.filter((document) => document.kind === input.kind);
    if (input.topicId !== undefined) {
      const ids = new Set(
        this.db
          .select({ documentId: researchTopicDocuments.documentId })
          .from(researchTopicDocuments)
          .where(eq(researchTopicDocuments.topicId, input.topicId))
          .all()
          .map((row) => row.documentId),
      );
      allowed = allowed.filter((document) => ids.has(document.id));
    }
    if (input.subject !== undefined) {
      const split = input.subject.indexOf(':');
      const subjectKind = split < 0 ? undefined : input.subject.slice(0, split);
      const subjectKey = split < 0 ? input.subject : input.subject.slice(split + 1);
      const ids = new Set(
        this.db
          .select({ ownerId: researchSubjectLinks.ownerId })
          .from(researchSubjectLinks)
          .where(
            and(
              eq(researchSubjectLinks.ownerKind, 'document'),
              subjectKind === undefined
                ? undefined
                : eq(researchSubjectLinks.subjectKind, subjectKind),
              eq(researchSubjectLinks.subjectKey, subjectKey),
            ),
          )
          .all()
          .map((row) => row.ownerId),
      );
      allowed = allowed.filter((document) => ids.has(document.id));
    }
    const documents = new Map(allowed.map((document) => [document.id, document]));
    const chunks = new Map(
      this.db
        .select()
        .from(researchDocumentChunks)
        .where(
          allowed.length === 0
            ? inArray(researchDocumentChunks.documentId, ['__none__'])
            : inArray(researchDocumentChunks.documentId, [...documents.keys()]),
        )
        .all()
        .map((chunk) => [`${chunk.documentId}\u0000${chunk.ordinal}`, chunk]),
    );
    return this.db
      .select()
      .from(researchChunkEmbeddings)
      .where(eq(researchChunkEmbeddings.identityKey, researchEmbeddingIdentityKey(input.identity)))
      .all()
      .flatMap((embedding) => {
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
            document: documentFrom(document),
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
}
