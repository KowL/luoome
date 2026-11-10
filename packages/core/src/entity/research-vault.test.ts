import { describe, expect, it } from 'vitest';
import {
  ResearchDocumentIndexSchema,
  ResearchDocumentKindSchema,
  researchDocumentDate,
} from './research-vault.js';

const document = () =>
  ResearchDocumentIndexSchema.parse({
    id: 'doc_note',
    kind: 'note',
    title: '库存周期笔记',
    importedAt: new Date('2026-08-01T00:00:00Z'),
    tags: ['周期'],
    stockCodes: ['600519.SH'],
    vaultId: 'vault-main',
    relativePath: 'notes/cycle.md',
    attachmentPaths: [],
    contentHash: 'a'.repeat(64),
    excerpt: '库存见底',
    fileModifiedAt: new Date('2026-08-01T00:00:00Z'),
    indexedAt: new Date('2026-08-02T00:00:00Z'),
    availability: 'available',
  });

describe('ResearchDocumentIndex', () => {
  it('keeps document fields, stock codes and safe relative paths', () => {
    const parsed = document();
    expect(parsed.stockCodes).toEqual(['600519.SH']);
    expect(parsed.availability).toBe('available');
    expect(ResearchDocumentKindSchema.parse(parsed.kind)).toBe('note');
  });

  it('defaults stock codes for legacy rows and rejects unsafe paths', () => {
    const { stockCodes: _stockCodes, ...legacy } = document();
    expect(ResearchDocumentIndexSchema.parse(legacy).stockCodes).toEqual([]);
    expect(() =>
      ResearchDocumentIndexSchema.parse({ ...document(), relativePath: '../escape.md' }),
    ).toThrow();
    expect(() =>
      ResearchDocumentIndexSchema.parse({ ...document(), relativePath: '/abs/path.md' }),
    ).toThrow();
  });

  it('selects observedAt, publishedAt then importedAt as the document date', () => {
    const base = document();
    expect(researchDocumentDate(base)).toEqual(base.importedAt);
    expect(
      researchDocumentDate({ ...base, publishedAt: new Date('2026-08-03T00:00:00Z') }),
    ).toEqual(new Date('2026-08-03T00:00:00Z'));
    expect(
      researchDocumentDate({
        ...base,
        publishedAt: new Date('2026-08-03T00:00:00Z'),
        observedAt: new Date('2026-08-04T00:00:00Z'),
      }),
    ).toEqual(new Date('2026-08-04T00:00:00Z'));
  });
});
