import type {
  ResearchDocumentChunk,
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

const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryResearchIndexRepository implements ResearchIndexRepository {
  private topics = new Map<string, ResearchTopicIndex>();
  private documents = new Map<string, ResearchDocumentIndex>();
  private topicDocuments: ResearchTopicDocument[] = [];
  private subjectLinks: ResearchSubjectLink[] = [];
  private chunks: ResearchDocumentChunk[] = [];

  searchCapability(): ResearchSearchCapability {
    return 'metadata';
  }

  async applyIndexBatch(
    input: Parameters<ResearchIndexRepository['applyIndexBatch']>[0],
  ): Promise<ResearchIndexApplySummary> {
    const topics = new Map(this.topics);
    const documents = new Map(this.documents);
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    for (const topic of input.topics) {
      const previous = topics.get(topic.id);
      if (!previous) added++;
      else if (
        previous.contentHash === topic.contentHash &&
        previous.relativePath === topic.relativePath
      ) {
        unchanged++;
      } else updated++;
      topics.set(topic.id, copy(topic));
    }
    for (const document of input.documents) {
      const previous = documents.get(document.id);
      if (!previous) added++;
      else if (
        previous.contentHash === document.contentHash &&
        previous.relativePath === document.relativePath
      ) {
        unchanged++;
      } else updated++;
      documents.set(document.id, copy(document));
    }

    let missing = 0;
    if (input.completeness === 'complete') {
      for (const [id, old] of topics) {
        if (!input.seenTopicIds.has(id) && old.availability !== 'missing') {
          topics.set(id, {
            ...old,
            availability: 'missing',
            diagnostic: '文件未在最近一次完整扫描中出现',
          });
          missing++;
        }
      }
      for (const [id, old] of documents) {
        if (!input.seenDocumentIds.has(id) && old.availability !== 'missing') {
          documents.set(id, {
            ...old,
            availability: 'missing',
            diagnostic: '文件未在最近一次完整扫描中出现',
          });
          missing++;
        }
      }
    }

    this.topics = topics;
    this.documents = documents;
    const owners = new Set([
      ...input.topics.map((topic) => `topic:${topic.id}`),
      ...input.documents.map((document) => `document:${document.id}`),
    ]);
    this.topicDocuments = [
      ...this.topicDocuments.filter(
        (relation) =>
          !input.topics.some((topic) => topic.id === relation.topicId) &&
          !input.documents.some((document) => document.id === relation.documentId),
      ),
      ...copy(input.topicDocuments),
    ];
    this.subjectLinks = [
      ...this.subjectLinks.filter((link) => !owners.has(`${link.ownerKind}:${link.ownerId}`)),
      ...copy(input.subjectLinks),
    ];
    this.chunks = [
      ...this.chunks.filter(
        (chunk) => !input.documents.some((document) => document.id === chunk.documentId),
      ),
      ...copy(input.chunks),
    ];
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
    const value = this.topics.get(id);
    return value ? copy(value) : null;
  }

  async findDocument(id: string): Promise<ResearchDocumentIndex | null> {
    const value = this.documents.get(id);
    return value ? copy(value) : null;
  }

  async listTopics(query: ResearchTopicQuery): Promise<readonly ResearchTopicIndex[]> {
    return [...this.topics.values()]
      .filter((topic) => query.includeArchived || !topic.archivedAt)
      .filter((topic) => !query.kind || topic.kind === query.kind)
      .filter((topic) => !query.availability || topic.availability === query.availability)
      .filter(
        (topic) =>
          !query.subject ||
          this.subjectLinks.some(
            (link) =>
              link.ownerKind === 'topic' &&
              link.ownerId === topic.id &&
              `${link.subjectKind}:${link.subjectKey}` === query.subject,
          ),
      )
      .filter((topic) => !query.tags?.length || query.tags.every((tag) => topic.tags.includes(tag)))
      .sort((a, b) => b.indexedAt.getTime() - a.indexedAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, query.limit ?? 50)
      .map(copy);
  }

  async listDocuments(query: ResearchDocumentQuery): Promise<readonly ResearchDocumentIndex[]> {
    return [...this.documents.values()]
      .filter((document) => !query.kind || document.kind === query.kind)
      .filter((document) => !query.availability || document.availability === query.availability)
      .filter(
        (document) =>
          !query.topicId ||
          this.topicDocuments.some(
            (relation) => relation.topicId === query.topicId && relation.documentId === document.id,
          ),
      )
      .filter(
        (document) =>
          !query.subject ||
          this.subjectLinks.some(
            (link) =>
              link.ownerKind === 'document' &&
              link.ownerId === document.id &&
              `${link.subjectKind}:${link.subjectKey}` === query.subject,
          ),
      )
      .filter(
        (document) => !query.tags?.length || query.tags.every((tag) => document.tags.includes(tag)),
      )
      .filter(
        (document) =>
          !query.publishedFrom ||
          (document.publishedAt ?? document.importedAt) >= query.publishedFrom,
      )
      .filter(
        (document) =>
          !query.publishedTo || (document.publishedAt ?? document.importedAt) <= query.publishedTo,
      )
      .sort(
        (a, b) =>
          (b.observedAt ?? b.publishedAt ?? b.importedAt).getTime() -
            (a.observedAt ?? a.publishedAt ?? a.importedAt).getTime() || a.id.localeCompare(b.id),
      )
      .slice(0, query.limit ?? 50)
      .map(copy);
  }

  async searchDocuments(query: ResearchSearchQuery): Promise<readonly ResearchSearchHit[]> {
    const needle = query.text.trim().toLocaleLowerCase();
    if (!needle) return [];
    const allowed = new Set(
      (
        await this.listDocuments({
          ...(query.topicId ? { topicId: query.topicId } : {}),
          ...(query.subject ? { subject: query.subject } : {}),
          ...(query.kind ? { kind: query.kind } : {}),
          limit: Number.MAX_SAFE_INTEGER,
        })
      ).map((document) => document.id),
    );
    return this.chunks
      .filter((chunk) => allowed.has(chunk.documentId))
      .filter((chunk) => chunk.body.toLocaleLowerCase().includes(needle))
      .slice(0, query.limit ?? 50)
      .flatMap((chunk) => {
        const document = this.documents.get(chunk.documentId);
        return document
          ? [
              {
                document: copy(document),
                ordinal: chunk.ordinal,
                headingPath: chunk.headingPath,
                snippet: chunk.body.slice(0, 500),
                score: 1,
              },
            ]
          : [];
      });
  }

  async listStockSubjectKeys(): Promise<readonly string[]> {
    return [
      ...new Set(
        this.subjectLinks
          .filter((link) => link.subjectKind === 'stock')
          .map((link) => link.subjectKey),
      ),
    ].sort();
  }

  async listSubjectLinks(
    input: Parameters<ResearchIndexRepository['listSubjectLinks']>[0] = {},
  ): Promise<readonly ResearchSubjectLink[]> {
    return this.subjectLinks
      .filter((link) => input.ownerKind === undefined || link.ownerKind === input.ownerKind)
      .filter((link) => input.ownerId === undefined || link.ownerId === input.ownerId)
      .filter((link) => input.subjectKind === undefined || link.subjectKind === input.subjectKind)
      .filter((link) => input.subjectKey === undefined || link.subjectKey === input.subjectKey)
      .map(copy);
  }

  async listTopicDocuments(topicId: string): Promise<readonly ResearchTopicDocument[]> {
    return this.topicDocuments.filter((relation) => relation.topicId === topicId).map(copy);
  }
}
