import { describe, expect, it } from 'vitest';
import type { ResearchDocumentIndex, ResearchTopicIndex } from '@luoome/core';
import { InMemoryResearchIndexRepository } from './memory/research-index.js';

const topic = (id: string): ResearchTopicIndex => ({ id: `topic_${id}`, title: id, kind: 'industry', tags: [], vaultId: 'v', relativePath: `Research/${id}.md`, contentHash: 'a'.repeat(64), fileModifiedAt: new Date('2026-01-01'), indexedAt: new Date('2026-01-01'), availability: 'available' });
const document = (id: string): ResearchDocumentIndex => ({ id: `doc_${id}`, title: id, kind: 'report', importedAt: new Date('2026-01-01'), tags: [], vaultId: 'v', relativePath: `Research/${id}.md`, attachmentPaths: [], contentHash: 'b'.repeat(64), fileModifiedAt: new Date('2026-01-01'), indexedAt: new Date('2026-01-01'), availability: 'available' });

describe('ResearchIndexRepository contract (memory)', () => {
  it('upserts, replaces links/chunks, and marks unseen entries missing only on complete scans', async () => {
    const repo = new InMemoryResearchIndexRepository();
    await repo.applyIndexBatch({ vaultId: 'v', completeness: 'complete', topics: [topic('industry')], documents: [document('report')], topicDocuments: [{ topicId: 'topic_industry', documentId: 'doc_report', relation: 'supporting' }], subjectLinks: [{ ownerKind: 'topic', ownerId: 'topic_industry', subjectKind: 'industry', subjectKey: '白酒', relation: 'primary' }], chunks: [{ documentId: 'doc_report', ordinal: 0, headingPath: '摘要', contentHash: 'b'.repeat(64), body: '库存' }], seenTopicIds: new Set(['topic_industry']), seenDocumentIds: new Set(['doc_report']), indexedAt: new Date('2026-01-01') });
    expect((await repo.searchDocuments({ text: '库存' }))).toHaveLength(1);
    await repo.applyIndexBatch({ vaultId: 'v', completeness: 'complete', topics: [], documents: [], topicDocuments: [], subjectLinks: [], chunks: [], seenTopicIds: new Set(), seenDocumentIds: new Set(), indexedAt: new Date('2026-01-02') });
    expect((await repo.findTopic('topic_industry'))?.availability).toBe('missing');
  });
});
