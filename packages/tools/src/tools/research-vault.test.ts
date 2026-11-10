import { createHash } from 'node:crypto';

import type { ResearchVaultAdapterLike, ResearchVaultEntry, ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  createResearchDocumentTool,
  getResearchDocumentTool,
  listResearchDocumentsTool,
  searchResearchDocumentsTool,
  syncResearchVaultTool,
} from './research-vault.js';

const NOW = new Date('2026-08-01T00:00:00.000Z');

const entry = (relativePath: string, value: string): ResearchVaultEntry => ({
  relativePath,
  size: Buffer.byteLength(value),
  modifiedAt: new Date('2026-08-01T00:00:00.000Z'),
  contentHash: createHash('sha256').update(value).digest('hex'),
});

const createVault = (seed: Record<string, string> = {}) => {
  const files = new Map(Object.entries(seed));
  const adapter: ResearchVaultAdapterLike = {
    name: 'test-vault',
    vaultId: 'vault-test',
    managedRoot: 'Research/Luoome',
    scan: async () => [...files.entries()].map(([path, value]) => entry(path, value)),
    readText: async ({ relativePath }) => {
      const value = files.get(relativePath);
      if (value === undefined) throw new Error(`missing file: ${relativePath}`);
      return value;
    },
    createManagedDocument: async (input) => {
      if (files.has(input.relativePath)) throw new Error('target already exists');
      files.set(input.relativePath, input.content);
      return entry(input.relativePath, input.content);
    },
    importAttachment: async ({ suggestedName, content }) => {
      const extension = suggestedName.includes('.')
        ? suggestedName.slice(suggestedName.lastIndexOf('.'))
        : '';
      const relativePath = `Research/Luoome/Attachments/${createHash('sha256').update(content).digest('hex')}${extension}`;
      return entry(relativePath, 'attachment');
    },
    buildOpenUri: (relativePath) => `obsidian://open?file=${encodeURIComponent(relativePath)}`,
  };
  return { adapter, files };
};

const withVault = async (
  adapter: ResearchVaultAdapterLike,
  options: Parameters<typeof buildTestContext>[0] = {},
): Promise<ToolContext> => {
  const base = await buildTestContext({ clock: () => NOW, ...options });
  return { ...base, adapters: { ...base.adapters, researchVault: adapter } };
};

const documentMarkdown = (
  id: string,
  title: string,
  body: string,
  stockCodes: readonly string[] = [],
): string =>
  `---\nluoome_schema: '1'\nluoome_type: research-document\nluoome_id: ${id}\ntitle: ${title}\ndocument_kind: note\nimported_at: 2026-08-01T00:00:00.000Z\nstock_codes:\n${stockCodes.map((code) => `  - ${code}`).join('\n')}\n---\n${body}\n`;

describe('tool/research-vault', () => {
  it('sync 把 Vault Markdown 建入 document index，并保留 stockCodes 与 excerpt', async () => {
    const { adapter } = createVault({
      'Research/notes/a.md': documentMarkdown('doc_a', '白酒库存周期', '渠道库存下降，价格企稳。', [
        '600519.SH',
      ]),
      'Research/notes/b.md': documentMarkdown('doc_b', '第二篇笔记', '正文'),
      'Research/notes/readme.txt': 'not markdown',
    });
    const ctx = await withVault(adapter);

    const synced = await syncResearchVaultTool.execute({ mode: 'manual' }, ctx);
    expect(synced).toMatchObject({
      ok: true,
      data: { vaultId: 'vault-test', added: 2, invalid: 0, status: 'succeeded' },
    });
    const listed = await listResearchDocumentsTool.execute({ stockCode: '600519.SH' }, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.documents).toHaveLength(1);
    expect(listed.data.documents[0]).toMatchObject({
      id: 'doc_a',
      title: '白酒库存周期',
      stockCodes: ['600519.SH'],
      excerpt: '渠道库存下降，价格企稳。',
      availability: 'available',
    });
  });

  it('create_research_document 写入 managed Vault 后可被 get/list 读取', async () => {
    const { adapter, files } = createVault();
    const ctx = await withVault(adapter);

    const created = await createResearchDocumentTool.execute(
      {
        title: '光伏产能出清',
        kind: 'note',
        body: '硅料价格触底。',
        stockCodes: ['002594.SZ'],
        tags: ['industry'],
      },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.indexed).toBe(true);
    expect([...files.keys()]).toHaveLength(1);

    const got = await getResearchDocumentTool.execute(
      { documentId: created.data.documentId, includeContent: true },
      ctx,
    );
    expect(got.ok).toBe(true);
    if (!got.ok || got.data === null) return;
    expect(got.data.document.stockCodes).toEqual(['002594.SZ']);
    expect(got.data.content).toContain('硅料价格触底');
    expect(got.data.obsidianUri).toContain('obsidian://open');

    const listed = await listResearchDocumentsTool.execute({ tags: ['industry'] }, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.documents.map((document) => document.title)).toEqual(['光伏产能出清']);
  });

  it('search_research_documents 返回命中并在 FTS 不可用时明确降级', async () => {
    const { adapter } = createVault({
      'Research/notes/a.md': documentMarkdown(
        'doc_search',
        '渠道库存周报',
        '中秋动销超预期，库存回落。',
        ['600519.SH'],
      ),
    });
    const ctx = await withVault(adapter);
    await syncResearchVaultTool.execute({ mode: 'manual' }, ctx);

    const hits = await searchResearchDocumentsTool.execute({ text: '库存' }, ctx);
    expect(hits.ok).toBe(true);
    if (!hits.ok) return;
    expect(['fts', 'metadata']).toContain(hits.data.capability);
    expect(hits.data.hits.map((hit) => hit.document.id)).toContain('doc_search');
  });

  it('未配置 Vault 时 create/get content 返回 permission_denied，list/search 仍读索引', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const created = await createResearchDocumentTool.execute(
      { title: '无 Vault', kind: 'note', body: '', stockCodes: [], tags: [] },
      ctx,
    );
    expect(created).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });

    const listed = await listResearchDocumentsTool.execute({}, ctx);
    expect(listed).toMatchObject({ ok: true, data: { documents: [] } });
    const searched = await searchResearchDocumentsTool.execute({ text: '库存' }, ctx);
    expect(searched.ok).toBe(true);
    if (!searched.ok) return;
    expect(searched.data.hits).toEqual([]);
  });
});
