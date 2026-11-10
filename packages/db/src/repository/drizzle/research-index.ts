import type {
  ResearchDocumentIndex,
  ResearchDocumentQuery,
  ResearchIndexApplySummary,
  ResearchIndexRepository,
  ResearchSearchCapability,
  ResearchSearchHit,
  ResearchSearchQuery,
} from '@luoome/core';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';

import type { DrizzleDb } from '../../client.js';
import { researchDocumentFts, researchDocumentIndex } from '../../schema/index.js';

const documentFrom = (row: typeof researchDocumentIndex.$inferSelect): ResearchDocumentIndex => ({
  ...row,
  tags: [...(row.tags ?? [])],
  stockCodes: [...(row.stockCodes ?? [])],
  attachmentPaths: [...(row.attachmentPaths ?? [])],
  author: row.author ?? undefined,
  sourceUrl: row.sourceUrl ?? undefined,
  sourceStatus: (row.sourceStatus ?? undefined) as ResearchDocumentIndex['sourceStatus'],
  publishedAt: row.publishedAt ?? undefined,
  observedAt: row.observedAt ?? undefined,
  excerpt: row.excerpt ?? undefined,
  diagnostic: row.diagnostic ?? undefined,
  kind: row.kind as ResearchDocumentIndex['kind'],
  availability: row.availability as ResearchDocumentIndex['availability'],
});

const documentRow = (
  document: ResearchDocumentIndex,
): typeof researchDocumentIndex.$inferInsert => ({
  ...document,
  tags: [...document.tags],
  stockCodes: [...(document.stockCodes ?? [])],
  attachmentPaths: [...document.attachmentPaths],
  author: document.author ?? null,
  sourceUrl: document.sourceUrl ?? null,
  sourceStatus: document.sourceStatus ?? null,
  publishedAt: document.publishedAt ?? null,
  observedAt: document.observedAt ?? null,
  excerpt: document.excerpt ?? null,
  diagnostic: document.diagnostic ?? null,
});

const ftsRow = (
  document: ResearchDocumentIndex,
  body: string,
): typeof researchDocumentFts.$inferInsert => ({
  documentId: document.id,
  contentHash: document.contentHash,
  title: document.title,
  tags: document.tags.join(' '),
  relativePath: document.relativePath,
  excerpt: document.excerpt ?? '',
  body,
});

/**
 * 研究笔记索引：`research_document_index` 权威单表 + `research_document_fts` 派生投影。
 *
 * FTS 行按 document 粒度保存 title/tags/relativePath/excerpt 与本地 Markdown 正文；
 * 不再有 chunk/embedding/topic/hypothesis/subject-link 表。
 */
export class DrizzleResearchIndexRepository implements ResearchIndexRepository {
  private ftsAvailable: boolean;

  constructor(private readonly db: DrizzleDb) {
    this.ftsAvailable = this.detectFts();
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

  async applyIndexBatch(
    input: Parameters<ResearchIndexRepository['applyIndexBatch']>[0],
  ): Promise<ResearchIndexApplySummary> {
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let missing = 0;
    this.db.transaction((tx) => {
      for (const document of input.documents) {
        const old = tx
          .select({
            hash: researchDocumentIndex.contentHash,
            path: researchDocumentIndex.relativePath,
          })
          .from(researchDocumentIndex)
          .where(eq(researchDocumentIndex.id, document.id))
          .get();
        if (old === undefined) added++;
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
      const markMissing = (row: {
        id: string;
        availability: string;
        diagnostic: string | null;
      }) => {
        if (row.availability === 'missing') return;
        tx.update(researchDocumentIndex)
          .set({ availability: 'missing', diagnostic: '文件未在最近一次完整扫描中出现' })
          .where(eq(researchDocumentIndex.id, row.id))
          .run();
        if (this.ftsAvailable) {
          try {
            tx.delete(researchDocumentFts).where(eq(researchDocumentFts.documentId, row.id)).run();
          } catch {
            this.ftsAvailable = false;
          }
        }
        missing++;
      };
      if (input.completeness === 'complete') {
        const present = new Set(input.documents.map((document) => document.id));
        for (const row of tx
          .select()
          .from(researchDocumentIndex)
          .where(eq(researchDocumentIndex.vaultId, input.vaultId))
          .all()) {
          if (!input.seenDocumentIds.has(row.id) && !present.has(row.id)) markMissing(row);
        }
      }
      if (this.ftsAvailable) {
        try {
          for (const document of input.documents) {
            tx.delete(researchDocumentFts)
              .where(eq(researchDocumentFts.documentId, document.id))
              .run();
            if (document.availability !== 'available') continue;
            const body = input.contents?.[document.id] ?? document.excerpt ?? '';
            tx.insert(researchDocumentFts).values(ftsRow(document, body)).run();
          }
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
      invalid: input.documents.filter((document) => document.availability === 'invalid').length,
      conflicts: input.documents.filter((document) => document.availability === 'conflict').length,
    };
  }

  async findDocument(id: string): Promise<ResearchDocumentIndex | null> {
    const row = this.db
      .select()
      .from(researchDocumentIndex)
      .where(eq(researchDocumentIndex.id, id))
      .get();
    return row === undefined ? null : documentFrom(row);
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
        (document) => !query.tags?.length || query.tags.every((tag) => document.tags.includes(tag)),
      )
      .filter(
        (document) =>
          query.stockCode === undefined || document.stockCodes.includes(query.stockCode),
      )
      .slice(0, query.limit ?? 50);
  }

  async searchDocuments(query: ResearchSearchQuery): Promise<readonly ResearchSearchHit[]> {
    const searchText = query.text.trim();
    if (searchText.length === 0) return [];
    const allowed = (
      await this.listDocuments({
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.stockCode ? { stockCode: query.stockCode } : {}),
        limit: 10_000,
      })
    ).filter((document) => document.availability !== 'missing');
    if (allowed.length === 0) return [];
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
            body: researchDocumentFts.body,
            snippet: sql<string>`snippet(${researchDocumentFts}, 6, '<mark>', '</mark>', '…', 20)`,
            score: sql<number>`bm25(${researchDocumentFts})`,
          })
          .from(researchDocumentFts)
          .innerJoin(
            researchDocumentIndex,
            eq(researchDocumentIndex.id, researchDocumentFts.documentId),
          )
          .where(sql`${researchDocumentFts} MATCH ${match}`)
          .orderBy(sql`bm25(${researchDocumentFts})`)
          .limit((query.limit ?? 50) * 5)
          .all();
        const allowedIds = new Set(allowed.map((document) => document.id));
        const hits: ResearchSearchHit[] = [];
        for (const row of rows) {
          if (!allowedIds.has(row.document.id)) continue;
          hits.push({
            document: documentFrom(row.document),
            snippet: row.snippet || row.body.slice(0, 500),
            score: row.score,
          });
          if (hits.length >= (query.limit ?? 50)) break;
        }
        // tokenizer 在部分 CJK 文本上不产生可匹配词元；用 metadata 子串搜索兜底。
        if (hits.length > 0) return hits;
      } catch {
        this.ftsAvailable = false;
      }
    }
    return allowed
      .filter(
        (document) =>
          document.title.includes(searchText) ||
          (document.excerpt ?? '').includes(searchText) ||
          document.relativePath.includes(searchText),
      )
      .slice(0, query.limit ?? 50)
      .map((document) => {
        const index = document.excerpt ?? document.title;
        return {
          document,
          snippet: index.length > 500 ? `${index.slice(0, 500)}…` : index,
          score: 1,
        };
      });
  }

  async listStockCodes(): Promise<readonly string[]> {
    return [
      ...new Set(
        this.db
          .select()
          .from(researchDocumentIndex)
          .all()
          .flatMap((row) => row.stockCodes ?? []),
      ),
    ].sort();
  }
}
