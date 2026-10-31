import {
  assertExternalMarketFactInvariants,
  type ExternalFactDraft,
  type ExternalFactKind,
  type ExternalMarketFact,
  type ExternalMarketFactRepository,
  ExternalMarketFactSchema,
  externalFactContentHash,
  externalFactId,
} from '@luoome/core';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';

import type { DrizzleDatabase } from '../../database.js';
import { externalMarketFacts, type Schema } from '../../schema/index.js';

const parse = (row: typeof externalMarketFacts.$inferSelect): ExternalMarketFact =>
  ExternalMarketFactSchema.parse({
    id: row.id,
    kind: row.kind,
    subjectKey: row.subjectKey,
    ...(row.category === null ? {} : { category: row.category }),
    observedAt: row.observedAt,
    fetchedAt: row.fetchedAt,
    source: row.source,
    provenance: row.provenance,
    payload: row.payload,
    contentHash: row.contentHash,
    recordedAt: row.recordedAt,
    ...(row.revisedAt === null ? {} : { revisedAt: row.revisedAt }),
    referencedBy: [...row.referencedBy],
  });

/**
 * External 市场事实 drizzle 实现。
 *
 * upsert 语义（与 in-memory 逐条对齐，contract tests 对拍）：
 * - 同 id 首次 → `inserted`，`recordedAt = now`
 * - 同 id 内容变了 → `updated`，覆盖 payload / contentHash，**`recordedAt` 保留首次**，写 `revisedAt`
 * - 同 id 内容没变 → `unchanged`，不写库
 */
export class DrizzleExternalMarketFactRepository implements ExternalMarketFactRepository {
  constructor(private readonly db: DrizzleDatabase<Schema>) {}

  async upsert(input: { readonly draft: ExternalFactDraft; readonly now: Date }): Promise<{
    readonly outcome: 'inserted' | 'updated' | 'unchanged';
    readonly fact: ExternalMarketFact;
  }> {
    const id = externalFactId(input.draft);
    const existing = await this.findById(id);
    const contentHash = externalFactContentHash({
      kind: input.draft.kind,
      source: input.draft.source,
      subjectKey: input.draft.subjectKey,
      observedAt: input.draft.observedAt,
      payload: input.draft.payload,
    });
    if (existing !== null && existing.contentHash === contentHash)
      return { outcome: 'unchanged', fact: existing };

    const next: ExternalMarketFact = {
      id,
      kind: input.draft.kind,
      subjectKey: input.draft.subjectKey,
      ...(input.draft.category === undefined ? {} : { category: input.draft.category }),
      observedAt: input.draft.observedAt,
      fetchedAt: input.now,
      source: input.draft.source,
      provenance: input.draft.provenance,
      payload: input.draft.payload,
      contentHash,
      // 首次落库时间永不变；内容更正只写 revisedAt。
      recordedAt: existing?.recordedAt ?? input.now,
      ...(existing === null ? {} : { revisedAt: input.now }),
      referencedBy: [...(existing?.referencedBy ?? [])],
    };
    assertExternalMarketFactInvariants(next);
    const row = {
      id: next.id,
      kind: next.kind,
      subjectKey: next.subjectKey,
      category: next.category ?? null,
      observedAt: next.observedAt,
      fetchedAt: next.fetchedAt,
      source: next.source,
      provenance: next.provenance,
      payload: next.payload,
      contentHash: next.contentHash,
      recordedAt: next.recordedAt,
      revisedAt: next.revisedAt ?? null,
      referencedBy: [...next.referencedBy],
    };
    this.db
      .insert(externalMarketFacts)
      .values(row)
      .onConflictDoUpdate({
        target: externalMarketFacts.id,
        set: {
          category: row.category,
          fetchedAt: row.fetchedAt,
          provenance: row.provenance,
          payload: row.payload,
          contentHash: row.contentHash,
          revisedAt: row.revisedAt,
          referencedBy: row.referencedBy,
        },
      })
      .run();
    return { outcome: existing === null ? 'inserted' : 'updated', fact: next };
  }

  async findById(id: string): Promise<ExternalMarketFact | null> {
    const row = this.db
      .select()
      .from(externalMarketFacts)
      .where(eq(externalMarketFacts.id, id))
      .get();
    return row === undefined ? null : parse(row);
  }

  async findByIds(ids: readonly string[]): Promise<readonly ExternalMarketFact[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(externalMarketFacts)
      .where(inArray(externalMarketFacts.id, [...ids]))
      .all()
      .map(parse);
  }

  async listByKind(input: {
    readonly kind: ExternalFactKind;
    readonly from?: Date;
    readonly to?: Date;
    readonly limit?: number;
  }): Promise<readonly ExternalMarketFact[]> {
    const conditions = [eq(externalMarketFacts.kind, input.kind)];
    if (input.from !== undefined) conditions.push(gte(externalMarketFacts.observedAt, input.from));
    if (input.to !== undefined) conditions.push(lte(externalMarketFacts.observedAt, input.to));
    return this.db
      .select()
      .from(externalMarketFacts)
      .where(and(...conditions))
      .orderBy(desc(externalMarketFacts.observedAt), externalMarketFacts.id)
      .limit(input.limit ?? 500)
      .all()
      .map(parse);
  }

  async addReference(id: string, referencedBy: string): Promise<ExternalMarketFact | null> {
    const existing = await this.findById(id);
    if (existing === null) return null;
    if (existing.referencedBy.includes(referencedBy)) return existing;
    const next = [...existing.referencedBy, referencedBy].sort();
    this.db
      .update(externalMarketFacts)
      .set({ referencedBy: next })
      .where(eq(externalMarketFacts.id, id))
      .run();
    return { ...existing, referencedBy: next };
  }
}
