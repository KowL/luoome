import type { ResearchIndexRepository, ResearchSearchQuery, ResearchTopicQuery, ResearchDocumentQuery, ResearchIndexApplySummary } from '@luoome/core';
import { ResearchDocumentIndexSchema, ResearchTopicIndexSchema, type ResearchDocumentChunk, type ResearchDocumentIndex, type ResearchSubjectLink, type ResearchTopicDocument, type ResearchTopicIndex } from '@luoome/core';
import type { ResearchSearchHit } from '@luoome/core';

const copy = <T>(value: T): T => structuredClone(value);
export class InMemoryResearchIndexRepository implements ResearchIndexRepository {
  private topics = new Map<string, ResearchTopicIndex>(); private documents = new Map<string, ResearchDocumentIndex>();
  private topicDocuments: ResearchTopicDocument[] = []; private subjectLinks: ResearchSubjectLink[] = []; private chunks: ResearchDocumentChunk[] = [];
  async applyIndexBatch(input: Parameters<ResearchIndexRepository['applyIndexBatch']>[0]): Promise<ResearchIndexApplySummary> {
    const topics = new Map(this.topics); const documents = new Map(this.documents);
    let added = 0; let updated = 0; let unchanged = 0;
    for (const topic of input.topics) { const previous = topics.get(topic.id); if (!previous) added++; else if (previous.contentHash === topic.contentHash && previous.relativePath === topic.relativePath) unchanged++; else updated++; topics.set(topic.id, copy(topic)); }
    for (const document of input.documents) { const previous = documents.get(document.id); if (!previous) added++; else if (previous.contentHash === document.contentHash && previous.relativePath === document.relativePath) unchanged++; else updated++; documents.set(document.id, copy(document)); }
    let missing = 0;
    if (input.completeness === 'complete') {
      for (const [id, old] of topics) if (!input.seenTopicIds.has(id) && old.availability !== 'missing') { topics.set(id, { ...old, availability: 'missing', diagnostic: '文件未在最近一次完整扫描中出现' }); missing++; }
      for (const [id, old] of documents) if (!input.seenDocumentIds.has(id) && old.availability !== 'missing') { documents.set(id, { ...old, availability: 'missing', diagnostic: '文件未在最近一次完整扫描中出现' }); missing++; }
    }
    this.topics = topics; this.documents = documents;
    const owners = new Set([...input.topics.map((x) => `topic:${x.id}`), ...input.documents.map((x) => `document:${x.id}`)]);
    this.topicDocuments = [...this.topicDocuments.filter((x) => !input.topics.some((t) => t.id === x.topicId) && !input.documents.some((d) => d.id === x.documentId)), ...copy(input.topicDocuments)];
    this.subjectLinks = [...this.subjectLinks.filter((x) => !owners.has(`${x.ownerKind}:${x.ownerId}`)), ...copy(input.subjectLinks)];
    this.chunks = [...this.chunks.filter((x) => !input.documents.some((d) => d.id === x.documentId)), ...copy(input.chunks)];
    return { added, updated, unchanged, missing, invalid: input.topics.filter((x) => x.availability === 'invalid').length + input.documents.filter((x) => x.availability === 'invalid').length, conflicts: input.topics.filter((x) => x.availability === 'conflict').length + input.documents.filter((x) => x.availability === 'conflict').length };
  }
  async findTopic(id: string) { const value = this.topics.get(id); return value ? copy(value) : null; }
  async findDocument(id: string) { const value = this.documents.get(id); return value ? copy(value) : null; }
  async listTopics(query: ResearchTopicQuery) { return [...this.topics.values()].filter((x) => query.includeArchived || !x.archivedAt).filter((x) => !query.kind || x.kind === query.kind).filter((x) => !query.availability || x.availability === query.availability).filter((x) => !query.subject || this.subjectLinks.some((l) => l.ownerKind === 'topic' && l.ownerId === x.id && `${l.subjectKind}:${l.subjectKey}` === query.subject)).filter((x) => !query.tags?.length || query.tags.every((tag) => x.tags.includes(tag))).sort((a, b) => b.indexedAt.getTime() - a.indexedAt.getTime() || a.id.localeCompare(b.id)).slice(0, query.limit ?? 50).map(copy); }
  async listDocuments(query: ResearchDocumentQuery) { return [...this.documents.values()].filter((x) => !query.kind || x.kind === query.kind).filter((x) => !query.availability || x.availability === query.availability).filter((x) => !query.tags?.length || query.tags.every((tag) => x.tags.includes(tag))).filter((x) => !query.publishedFrom || (x.publishedAt && x.publishedAt >= query.publishedFrom)).filter((x) => !query.publishedTo || (x.publishedAt && x.publishedAt <= query.publishedTo)).filter((x) => !query.topicId || this.topicDocuments.some((r) => r.topicId === query.topicId && r.documentId === x.id)).filter((x) => !query.subject || this.subjectLinks.some((l) => l.ownerKind === 'document' && l.ownerId === x.id && `${l.subjectKind}:${l.subjectKey}` === query.subject)).sort((a, b) => (b.observedAt ?? b.publishedAt ?? b.importedAt).getTime() - (a.observedAt ?? a.publishedAt ?? a.importedAt).getTime() || a.id.localeCompare(b.id)).slice(0, query.limit ?? 50).map(copy); }
  async searchDocuments(query: ResearchSearchQuery): Promise<readonly ResearchSearchHit[]> { const needle = query.text.trim().toLocaleLowerCase(); if (!needle) return []; const result: ResearchSearchHit[] = []; for (const chunk of this.chunks) { const doc = this.documents.get(chunk.documentId); if (!doc || (query.kind && doc.kind !== query.kind) || (query.topicId && !this.topicDocuments.some((r) => r.topicId === query.topicId && r.documentId === doc.id)) || (query.subject && !this.subjectLinks.some((l) => l.ownerKind === 'document' && l.ownerId === doc.id && `${l.subjectKind}:${l.subjectKey}` === query.subject))) continue; if (!chunk.body.toLocaleLowerCase().includes(needle) && !doc.title.toLocaleLowerCase().includes(needle)) continue; result.push({ document: copy(doc), headingPath: chunk.headingPath, snippet: chunk.body.slice(0, 500), score: 1 }); } return result.slice(0, query.limit ?? 50); }
}
