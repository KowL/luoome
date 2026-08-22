import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  createResearchHypothesisVersionTool,
  listResearchHypothesisVersionsTool,
} from './research-hypothesis.js';

const now = new Date('2026-08-01T00:00:00.000Z');

const seedResearch = async (ctx: Awaited<ReturnType<typeof buildTestContext>>): Promise<void> => {
  await ctx.repos.researchIndex.applyIndexBatch({
    vaultId: 'vault-test',
    completeness: 'partial',
    topics: [
      {
        id: 'topic_industry',
        title: '白酒库存周期',
        kind: 'industry',
        tags: [],
        vaultId: 'vault-test',
        relativePath: 'Research/topic.md',
        contentHash: 'a'.repeat(64),
        fileModifiedAt: now,
        indexedAt: now,
        availability: 'available',
      },
    ],
    documents: [
      {
        id: 'doc_thesis',
        title: '当前判断',
        kind: 'thesis',
        importedAt: now,
        tags: [],
        vaultId: 'vault-test',
        relativePath: 'Research/thesis.md',
        attachmentPaths: [],
        contentHash: 'b'.repeat(64),
        fileModifiedAt: now,
        indexedAt: now,
        availability: 'available',
      },
      {
        id: 'doc_report',
        title: '普通报告',
        kind: 'report',
        importedAt: now,
        tags: [],
        vaultId: 'vault-test',
        relativePath: 'Research/report.md',
        attachmentPaths: [],
        contentHash: 'c'.repeat(64),
        fileModifiedAt: now,
        indexedAt: now,
        availability: 'available',
      },
    ],
    topicDocuments: [],
    subjectLinks: [],
    chunks: [],
    seenTopicIds: new Set(['topic_industry']),
    seenDocumentIds: new Set(['doc_thesis', 'doc_report']),
    indexedAt: now,
  });
};

describe('research hypothesis tools', () => {
  it('creates versioned thesis metadata and supersedes the prior active version', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedResearch(ctx);

    const first = await createResearchHypothesisVersionTool.execute(
      {
        topicId: 'topic_industry',
        documentId: 'doc_thesis',
        documentContentHash: 'b'.repeat(64),
        summary: '库存周期即将见底',
      },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await createResearchHypothesisVersionTool.execute(
      {
        topicId: 'topic_industry',
        documentId: 'doc_thesis',
        documentContentHash: 'b'.repeat(64),
      },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.hypothesisVersion.version).toBe(2);
    expect(second.data.hypothesisVersion.supersedesId).toBe(first.data.hypothesisVersion.id);
    const listed = await listResearchHypothesisVersionsTool.execute(
      { topicId: 'topic_industry' },
      ctx,
    );
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data).toMatchObject({
      hypothesisVersions: [
        { version: 2, status: 'active' },
        { version: 1, status: 'superseded' },
      ],
    });
  });

  it('rejects a missing topic, non-thesis document, and stale content hash', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedResearch(ctx);

    await expect(
      createResearchHypothesisVersionTool.execute(
        {
          topicId: 'topic_missing',
          documentId: 'doc_thesis',
          documentContentHash: 'b'.repeat(64),
        },
        ctx,
      ),
    ).resolves.toMatchObject({ ok: false, error: { kind: 'not_found' } });
    await expect(
      createResearchHypothesisVersionTool.execute(
        {
          topicId: 'topic_industry',
          documentId: 'doc_report',
          documentContentHash: 'c'.repeat(64),
        },
        ctx,
      ),
    ).resolves.toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    await expect(
      createResearchHypothesisVersionTool.execute(
        {
          topicId: 'topic_industry',
          documentId: 'doc_thesis',
          documentContentHash: 'd'.repeat(64),
        },
        ctx,
      ),
    ).resolves.toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });
});
