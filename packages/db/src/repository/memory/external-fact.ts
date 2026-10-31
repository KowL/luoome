import {
  assertExternalMarketFactInvariants,
  type ExternalFactDraft,
  type ExternalFactKind,
  type ExternalMarketFact,
  type ExternalMarketFactRepository,
  externalFactContentHash,
  externalFactId,
} from '@luoome/core';

/** 从 draft 派生完整事实（id / contentHash / recordedAt 由落库方算，不信任调用方）。 */
export const materializeExternalFact = (
  draft: ExternalFactDraft,
  now: Date,
  previous?: ExternalMarketFact,
): ExternalMarketFact => {
  const id = externalFactId({
    kind: draft.kind,
    source: draft.source,
    subjectKey: draft.subjectKey,
    observedAt: draft.observedAt,
  });
  const contentHash = externalFactContentHash({
    kind: draft.kind,
    source: draft.source,
    subjectKey: draft.subjectKey,
    observedAt: draft.observedAt,
    payload: draft.payload,
  });
  const fact: ExternalMarketFact = {
    id,
    kind: draft.kind,
    subjectKey: draft.subjectKey,
    ...(draft.category === undefined ? {} : { category: draft.category }),
    observedAt: draft.observedAt,
    fetchedAt: now,
    source: draft.source,
    provenance: draft.provenance,
    payload: draft.payload,
    contentHash,
    // 首次落库时间**永不变**：内容更正只写 revisedAt。
    recordedAt: previous?.recordedAt ?? now,
    ...(previous === undefined || previous.contentHash === contentHash
      ? previous?.revisedAt === undefined
        ? {}
        : { revisedAt: previous.revisedAt }
      : { revisedAt: now }),
    referencedBy: [...(previous?.referencedBy ?? [])],
  };
  assertExternalMarketFactInvariants(fact);
  return fact;
};

/** External 市场事实 in-memory 实现（与 drizzle 同语义，由 contract tests 对拍）。 */
export class InMemoryExternalMarketFactRepository implements ExternalMarketFactRepository {
  private readonly rows = new Map<string, ExternalMarketFact>();

  constructor(seed: readonly ExternalMarketFact[] = []) {
    for (const fact of seed) this.rows.set(fact.id, fact);
  }

  async upsert(input: { readonly draft: ExternalFactDraft; readonly now: Date }): Promise<{
    readonly outcome: 'inserted' | 'updated' | 'unchanged';
    readonly fact: ExternalMarketFact;
  }> {
    const id = externalFactId(input.draft);
    const previous = this.rows.get(id);
    const fact = materializeExternalFact(input.draft, input.now, previous);
    this.rows.set(id, fact);
    const outcome =
      previous === undefined
        ? 'inserted'
        : previous.contentHash === fact.contentHash
          ? 'unchanged'
          : 'updated';
    return { outcome, fact };
  }

  async findById(id: string): Promise<ExternalMarketFact | null> {
    return this.rows.get(id) ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<readonly ExternalMarketFact[]> {
    return ids.flatMap((id) => {
      const row = this.rows.get(id);
      return row === undefined ? [] : [row];
    });
  }

  async listByKind(input: {
    readonly kind: ExternalFactKind;
    readonly from?: Date;
    readonly to?: Date;
    readonly limit?: number;
  }): Promise<readonly ExternalMarketFact[]> {
    return [...this.rows.values()]
      .filter((row) => row.kind === input.kind)
      .filter((row) => input.from === undefined || row.observedAt >= input.from)
      .filter((row) => input.to === undefined || row.observedAt <= input.to)
      .sort(
        (left, right) =>
          right.observedAt.getTime() - left.observedAt.getTime() || left.id.localeCompare(right.id),
      )
      .slice(0, input.limit ?? 500);
  }

  async addReference(id: string, referencedBy: string): Promise<ExternalMarketFact | null> {
    const row = this.rows.get(id);
    if (row === undefined) return null;
    if (row.referencedBy.includes(referencedBy)) return row;
    const next: ExternalMarketFact = {
      ...row,
      referencedBy: [...row.referencedBy, referencedBy].sort(),
    };
    this.rows.set(id, next);
    return next;
  }
}
