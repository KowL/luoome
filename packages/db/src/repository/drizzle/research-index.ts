import type {
  ResearchDocumentIndex,
  ResearchDocumentQuery,
  ResearchIndexApplySummary,
  ResearchIndexRepository,
  ResearchSearchCapability,
  ResearchSearchHit,
  ResearchSearchQuery,
  ResearchSubjectLink,
  ResearchTopicDocument,
  ResearchTopicIndex,
  ResearchTopicQuery,
} from '@luoome/core';
import { and, asc, desc, eq, gte, inArray, like, lte, or, sql } from 'drizzle-orm';

import type { DrizzleDb } from '../../client.js';
import {
  researchDocumentChunks,
  researchDocumentFts,
  researchDocumentIndex,
  researchSubjectLinks,
  researchTopicDocuments,
  researchTopicIndex,
} from '../../schema/index.js';

const topicFrom = (row: typeof researchTopicIndex.$inferSelect): ResearchTopicIndex => ({
  ...row,
  tags: [...(row.tags ?? [])],
  archivedAt: row.archivedAt ?? undefined,
  summary: row.summary ?? undefined,
  diagnostic: row.diagnostic ?? undefined,
  availability: row.availability as ResearchTopicIndex['availability'],
});

const documentFrom = (row: typeof researchDocumentIndex.$inferSelect): ResearchDocumentIndex => ({
  ...row,
  tags: [...(row.tags ?? [])],
  attachmentPaths: [...(row.attachmentPaths ?? [])],
  author: row.author ?? undefined,
  sourceUrl: row.sourceUrl ?? undefined,
  sourceStatus: row.sourceStatus as ResearchDocumentIndex['sourceStatus'],
  publishedAt: row.publishedAt ?? undefined,
  observedAt: row.observedAt ?? undefined,
  excerpt: row.excerpt ?? undefined,
  diagnostic: row.diagnostic ?? undefined,
  kind: row.kind as ResearchDocumentIndex['kind'],
  availability: row.availability as ResearchDocumentIndex['availability'],
});

const topicRow = (topic: ResearchTopicIndex): typeof researchTopicIndex.$inferInsert => ({
  ...topic,
  tags: [...topic.tags],
  archivedAt: topic.archivedAt ?? null,
  summary: topic.summary ?? null,
  diagnostic: topic.diagnostic ?? null,
});

const documentRow = (
  document: ResearchDocumentIndex,
): typeof researchDocumentIndex.$inferInsert => ({
  ...document,
  tags: [...document.tags],
  attachmentPaths: [...document.attachmentPaths],
  author: document.author ?? null,
  sourceUrl: document.sourceUrl ?? null,
  sourceStatus: document.sourceStatus ?? null,
  publishedAt: document.publishedAt ?? null,
  observedAt: document.observedAt ?? null,
  excerpt: document.excerpt ?? null,
  diagnostic: document.diagnostic ?? null,
});

export class DrizzleResearchIndexRepository implements ResearchIndexRepository {
  private ftsAvailable: boolean;

  constructor(private readonly db: DrizzleDb) {
    this.ftsAvailable = this.detectFts();
    if (this.ftsAvailable) this.rebuildFts();
  }

  searchCapability(): ResearchSearchCapability {
    return this.ftsAvailable ? 'fts' : 'metadata';
  }

  private detectFts(): boolean {
    try {
      this.db
        .select({ documentId: researchDocumentFts.documentId })
        .from(researchDocumentFts)
        .limit(1)
        .all();
      return true;
    } catch {
      return false;
    }
  }

  private rebuildFts(): void {
    try {
      this.db.delete(researchDocumentFts).run();
      const rows = this.db
        .select({
          documentId: researchDocumentChunks.documentId,
          ordinal: researchDocumentChunks.ordinal,
          contentHash: researchDocumentChunks.contentHash,
          title: researchDocumentIndex.title,
          headingPath: researchDocumentChunks.headingPath,
          body: researchDocumentChunks.body,
        })
        .from(researchDocumentChunks)
        .innerJoin(
          researchDocumentIndex,
          eq(researchDocumentIndex.id, researchDocumentChunks.documentId),
        )
        .all();
      if (rows.length > 0) this.db.insert(researchDocumentFts).values(rows).run();
    } catch {
      this.ftsAvailable = false;
    }
  }

  async applyIndexBatch(
    input: Parameters<ResearchIndexRepository['applyIndexBatch']>[0],
  ): Promise<ResearchIndexApplySummary> {
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let missing = 0;
    this.db.transaction((tx) => {
      for (const topic of input.topics) {
        const old = tx
          .select({ hash: researchTopicIndex.contentHash, path: researchTopicIndex.relativePath })
          .from(researchTopicIndex)
          .where(eq(researchTopicIndex.id, topic.id))
          .get();
        if (!old) added++;
        else if (old.hash === topic.contentHash && old.path === topic.relativePath) unchanged++;
        else updated++;
        tx.insert(researchTopicIndex)
          .values(topicRow(topic))
          .onConflictDoUpdate({ target: researchTopicIndex.id, set: topicRow(topic) })
          .run();
      }
      for (const document of input.documents) {
        const old = tx
          .select({
            hash: researchDocumentIndex.contentHash,
            path: researchDocumentIndex.relativePath,
          })
          .from(researchDocumentIndex)
          .where(eq(researchDocumentIndex.id, document.id))
          .get();
        if (!old) added++;
        else if (old.hash === document.contentHash && old.path === document.relativePath)
          unchanged++;
        else updated++;
        tx.insert(researchDocumentIndex)
          .values(documentRow(document))
          .onConflictDoUpdate({
            target: researchDocumentIndex.id,
            set: documentRow(document),
          })
          .run();
      }
      if (input.completeness === 'complete') {
        for (const row of tx
          .select()
          .from(researchTopicIndex)
          .where(eq(researchTopicIndex.vaultId, input.vaultId))
          .all()) {
          if (!input.seenTopicIds.has(row.id) && row.availability !== 'missing') {
            tx.update(researchTopicIndex)
              .set({
                availability: 'missing',
                diagnostic: '文件未在最近一次完整扫描中出现',
              })
              .where(eq(researchTopicIndex.id, row.id))
              .run();
            missing++;
          }
        }
        for (const row of tx
          .select()
          .from(researchDocumentIndex)
          .where(eq(researchDocumentIndex.vaultId, input.vaultId))
          .all()) {
          if (!input.seenDocumentIds.has(row.id) && row.availability !== 'missing') {
            tx.update(researchDocumentIndex)
              .set({
                availability: 'missing',
                diagnostic: '文件未在最近一次完整扫描中出现',
              })
              .where(eq(researchDocumentIndex.id, row.id))
              .run();
            missing++;
          }
        }
      }
      for (const topic of input.topics) {
        tx.delete(researchSubjectLinks)
          .where(
            and(
              eq(researchSubjectLinks.ownerKind, 'topic'),
              eq(researchSubjectLinks.ownerId, topic.id),
            ),
          )
          .run();
      }
      for (const document of input.documents) {
        tx.delete(researchSubjectLinks)
          .where(
            and(
              eq(researchSubjectLinks.ownerKind, 'document'),
              eq(researchSubjectLinks.ownerId, document.id),
            ),
          )
          .run();
        tx.delete(researchTopicDocuments)
          .where(eq(researchTopicDocuments.documentId, document.id))
          .run();
        tx.delete(researchDocumentChunks)
          .where(eq(researchDocumentChunks.documentId, document.id))
          .run();
      }
      if (input.subjectLinks.length > 0) {
        tx.insert(researchSubjectLinks)
          .values([...input.subjectLinks])
          .onConflictDoNothing()
          .run();
      }
      if (input.topicDocuments.length > 0) {
        tx.insert(researchTopicDocuments)
          .values(
            input.topicDocuments.map((relation) => ({
              topicId: relation.topicId,
              documentId: relation.documentId,
              relation: relation.relation,
              sortOrder: relation.order ?? null,
            })),
          )
          .onConflictDoNothing()
          .run();
      }
      if (input.chunks.length > 0) {
        tx.insert(researchDocumentChunks)
          .values(
            input.chunks.map((chunk) => ({
              documentId: chunk.documentId,
              ordinal: chunk.ordinal,
              headingPath: chunk.headingPath,
              contentHash: chunk.contentHash,
              body: chunk.body,
            })),
          )
          .onConflictDoNothing()
          .run();
      }
      if (this.ftsAvailable) {
        try {
          for (const document of input.documents) {
            tx.delete(researchDocumentFts)
              .where(eq(researchDocumentFts.documentId, document.id))
              .run();
          }
          const ftsRows = input.chunks.map((chunk) => {
            const document = input.documents.find((item) => item.id === chunk.documentId);
            return {
              documentId: chunk.documentId,
              ordinal: chunk.ordinal,
              contentHash: chunk.contentHash,
              title: document?.title ?? '',
              headingPath: chunk.headingPath,
              body: chunk.body,
            };
          });
          if (ftsRows.length > 0) tx.insert(researchDocumentFts).values(ftsRows).run();
        } catch {
          this.ftsAvailable = false;
        }
      }
    });
    return {
      added,
      updated,
      unchanged,
      missing,
      invalid: [...input.topics, ...input.documents].filter(
        (entry) => entry.availability === 'invalid',
      ).length,
      conflicts: [...input.topics, ...input.documents].filter(
        (entry) => entry.availability === 'conflict',
      ).length,
    };
  }

  async findTopic(id: string): Promise<ResearchTopicIndex | null> {
    const row = this.db
      .select()
      .from(researchTopicIndex)
      .where(eq(researchTopicIndex.id, id))
      .get();
    return row ? topicFrom(row) : null;
  }

  async findDocument(id: string): Promise<ResearchDocumentIndex | null> {
    const row = this.db
      .select()
      .from(researchDocumentIndex)
      .where(eq(researchDocumentIndex.id, id))
      .get();
    return row ? documentFrom(row) : null;
  }

  async listTopics(query: ResearchTopicQuery): Promise<readonly ResearchTopicIndex[]> {
    return this.db
      .select()
      .from(researchTopicIndex)
      .where(
        and(
          query.kind ? eq(researchTopicIndex.kind, query.kind) : undefined,
          query.availability ? eq(researchTopicIndex.availability, query.availability) : undefined,
          query.includeArchived ? undefined : sql`${researchTopicIndex.archivedAt} IS NULL`,
        ),
      )
      .orderBy(desc(researchTopicIndex.indexedAt), asc(researchTopicIndex.id))
      .all()
      .map(topicFrom)
      .filter(
        (topic) =>
          !query.subject ||
          this.db
            .select()
            .from(researchSubjectLinks)
            .where(
              and(
                eq(researchSubjectLinks.ownerKind, 'topic'),
                eq(researchSubjectLinks.ownerId, topic.id),
                eq(
                  sql`(${researchSubjectLinks.subjectKind} || ':' || ${researchSubjectLinks.subjectKey})`,
                  query.subject,
                ),
              ),
            )
            .get() !== undefined,
      )
      .filter((topic) => !query.tags?.length || query.tags.every((tag) => topic.tags.includes(tag)))
      .slice(0, query.limit ?? 50);
  }

  async listDocuments(query: ResearchDocumentQuery): Promise<readonly ResearchDocumentIndex[]> {
    return this.db
      .select()
      .from(researchDocumentIndex)
      .where(
        and(
          query.kind ? eq(researchDocumentIndex.kind, query.kind) : undefined,
          query.availability
            ? eq(researchDocumentIndex.availability, query.availability)
            : undefined,
          query.publishedFrom
            ? gte(researchDocumentIndex.publishedAt, query.publishedFrom)
            : undefined,
          query.publishedTo ? lte(researchDocumentIndex.publishedAt, query.publishedTo) : undefined,
        ),
      )
      .orderBy(
        desc(researchDocumentIndex.observedAt),
        desc(researchDocumentIndex.publishedAt),
        desc(researchDocumentIndex.importedAt),
        asc(researchDocumentIndex.id),
      )
      .all()
      .map(documentFrom)
      .filter(
        (document) =>
          !query.topicId ||
          this.db
            .select()
            .from(researchTopicDocuments)
            .where(
              and(
                eq(researchTopicDocuments.topicId, query.topicId),
                eq(researchTopicDocuments.documentId, document.id),
              ),
            )
            .get() !== undefined,
      )
      .filter(
        (document) =>
          !query.subject ||
          this.db
            .select()
            .from(researchSubjectLinks)
            .where(
              and(
                eq(researchSubjectLinks.ownerKind, 'document'),
                eq(researchSubjectLinks.ownerId, document.id),
                eq(
                  sql`(${researchSubjectLinks.subjectKind} || ':' || ${researchSubjectLinks.subjectKey})`,
                  query.subject,
                ),
              ),
            )
            .get() !== undefined,
      )
      .filter(
        (document) => !query.tags?.length || query.tags.every((tag) => document.tags.includes(tag)),
      )
      .slice(0, query.limit ?? 50);
  }

  async searchDocuments(query: ResearchSearchQuery): Promise<readonly ResearchSearchHit[]> {
    const searchText = query.text.trim();
    if (searchText.length === 0) return [];
    const allowed = new Set(
      (
        await this.listDocuments({
          ...(query.topicId ? { topicId: query.topicId } : {}),
          ...(query.subject ? { subject: query.subject } : {}),
          ...(query.kind ? { kind: query.kind } : {}),
          limit: 10_000,
        })
      ).map((document) => document.id),
    );
    if (allowed.size === 0) return [];
    if (this.ftsAvailable) {
      const match = searchText
        .split(/\s+/u)
        .filter(Boolean)
        .map((token) => `"${token.replaceAll('"', '""')}"`)
        .join(' AND ');
      try {
        const rows = this.db
          .select({
            document: researchDocumentIndex,
            ordinal: researchDocumentFts.ordinal,
            headingPath: researchDocumentFts.headingPath,
            body: researchDocumentFts.body,
            snippet: sql<string>`snippet(${researchDocumentFts}, 5, '<mark>', '</mark>', '…', 20)`,
            score: sql<number>`bm25(${researchDocumentFts})`,
          })
          .from(researchDocumentFts)
          .innerJoin(
            researchDocumentIndex,
            eq(researchDocumentIndex.id, researchDocumentFts.documentId),
          )
          .where(
            and(
              inArray(researchDocumentIndex.id, [...allowed]),
              sql`${researchDocumentFts} MATCH ${match}`,
            ),
          )
          .orderBy(sql`bm25(${researchDocumentFts})`)
          .limit((query.limit ?? 50) * 5)
          .all();
        const hits: ResearchSearchHit[] = [];
        const seen = new Set<string>();
        for (const row of rows) {
          if (seen.has(row.document.id)) continue;
          seen.add(row.document.id);
          hits.push({
            document: documentFrom(row.document),
            ordinal: row.ordinal,
            headingPath: row.headingPath,
            snippet: row.snippet || row.body.slice(0, 500),
            score: row.score,
          });
          if (hits.length >= (query.limit ?? 50)) break;
        }
        // unicode61 在部分 CJK 文本上不会产生可匹配的词元；此时用 metadata
        // 子串搜索兜底，避免把“FTS 可用但 tokenizer 不适配”误报成正常零结果。
        if (hits.length > 0) return hits;
      } catch {
        this.ftsAvailable = false;
      }
    }
    return this.db
      .select({
        document: researchDocumentIndex,
        ordinal: researchDocumentChunks.ordinal,
        headingPath: researchDocumentChunks.headingPath,
        body: researchDocumentChunks.body,
      })
      .from(researchDocumentChunks)
      .innerJoin(
        researchDocumentIndex,
        eq(researchDocumentIndex.id, researchDocumentChunks.documentId),
      )
      .where(
        and(
          inArray(researchDocumentIndex.id, [...allowed]),
          or(
            like(researchDocumentChunks.body, `%${searchText}%`),
            like(researchDocumentIndex.title, `%${searchText}%`),
          ),
        ),
      )
      .limit(query.limit ?? 50)
      .all()
      .map((row) => ({
        document: documentFrom(row.document),
        ordinal: row.ordinal,
        headingPath: row.headingPath,
        snippet: row.body.slice(0, 500),
        score: 1,
      }));
  }

  async listStockSubjectKeys(): Promise<readonly string[]> {
    return this.db
      .selectDistinct({ subjectKey: researchSubjectLinks.subjectKey })
      .from(researchSubjectLinks)
      .where(eq(researchSubjectLinks.subjectKind, 'stock'))
      .orderBy(asc(researchSubjectLinks.subjectKey))
      .all()
      .map((row) => row.subjectKey);
  }

  async listSubjectLinks(
    input: Parameters<ResearchIndexRepository['listSubjectLinks']>[0] = {},
  ): Promise<readonly ResearchSubjectLink[]> {
    const rows = this.db
      .select()
      .from(researchSubjectLinks)
      .where(
        and(
          input.ownerKind ? eq(researchSubjectLinks.ownerKind, input.ownerKind) : undefined,
          input.ownerId ? eq(researchSubjectLinks.ownerId, input.ownerId) : undefined,
          input.subjectKind ? eq(researchSubjectLinks.subjectKind, input.subjectKind) : undefined,
          input.subjectKey ? eq(researchSubjectLinks.subjectKey, input.subjectKey) : undefined,
        ),
      )
      .all();
    return rows.map((row) => ({
      ownerKind: row.ownerKind as ResearchSubjectLink['ownerKind'],
      ownerId: row.ownerId,
      subjectKind: row.subjectKind as ResearchSubjectLink['subjectKind'],
      subjectKey: row.subjectKey,
      relation: row.relation as ResearchSubjectLink['relation'],
    }));
  }

  async listTopicDocuments(topicId: string): Promise<readonly ResearchTopicDocument[]> {
    return this.db
      .select()
      .from(researchTopicDocuments)
      .where(eq(researchTopicDocuments.topicId, topicId))
      .orderBy(asc(researchTopicDocuments.sortOrder), asc(researchTopicDocuments.documentId))
      .all()
      .map((row) => ({
        topicId: row.topicId,
        documentId: row.documentId,
        relation: row.relation as ResearchTopicDocument['relation'],
        ...(row.sortOrder === null ? {} : { order: row.sortOrder }),
      }));
  }
}
