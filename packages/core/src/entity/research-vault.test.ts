import { describe, expect, it } from 'vitest';

import {
  normalizeResearchSubject,
  ResearchDocumentIndexSchema,
  ResearchTopicIndexSchema,
} from '../index.js';

const base = {
  vaultId: 'vault-test',
  contentHash: 'a'.repeat(64),
  fileModifiedAt: new Date('2026-08-01T00:00:00.000Z'),
  indexedAt: new Date('2026-08-01T00:00:00.000Z'),
  availability: 'available' as const,
};

describe('Research Vault domain', () => {
  it('Topic 可以不关联股票，Document 可以独立属于产业或事件研究', () => {
    expect(
      ResearchTopicIndexSchema.parse({
        ...base,
        id: 'topic_industry_cycle',
        title: '产业周期',
        kind: 'industry',
        tags: [],
        relativePath: 'Research/Topics/industry.md',
      }),
    ).toMatchObject({ kind: 'industry' });
    expect(
      ResearchDocumentIndexSchema.parse({
        ...base,
        id: 'doc_event_update',
        title: '事件更新',
        kind: 'timeline-update',
        importedAt: base.indexedAt,
        tags: [],
        relativePath: 'Research/Documents/event.md',
        attachmentPaths: [],
      }),
    ).toMatchObject({ kind: 'timeline-update' });
  });

  it('拒绝绝对路径、父目录和 Windows drive 注入', () => {
    for (const relativePath of ['/etc/passwd', '../secret.md', 'C:\\secret.md']) {
      expect(() =>
        ResearchTopicIndexSchema.parse({
          ...base,
          id: 'topic_unsafe',
          title: 'unsafe',
          kind: 'custom',
          tags: [],
          relativePath,
        }),
      ).toThrow();
    }
  });

  it('规范化类型化 SubjectRef', () => {
    expect(normalizeResearchSubject('stock: 600519.SH ')).toEqual({
      kind: 'stock',
      key: '600519.SH',
    });
    expect(() => normalizeResearchSubject('unknown:x')).toThrow();
  });
});
