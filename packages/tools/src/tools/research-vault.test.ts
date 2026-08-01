import type { ResearchVaultAdapterLike } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { listResearchTopicsTool, syncResearchVaultTool } from './research-vault.js';

const vault = (content: string, scanError?: Error): ResearchVaultAdapterLike => ({
  name: 'test-vault',
  vaultId: 'vault-test',
  scan: async () => {
    if (scanError) throw scanError;
    return [
      {
        relativePath: 'Research/topic.md',
        size: Buffer.byteLength(content),
        modifiedAt: new Date('2026-08-01T00:00:00.000Z'),
        contentHash: 'a'.repeat(64),
      },
    ];
  },
  readText: async () => content,
  createManagedDocument: async () => {
    throw new Error('not used');
  },
  importAttachment: async () => {
    throw new Error('not used');
  },
  buildOpenUri: (relativePath) => `obsidian://open?file=${encodeURIComponent(relativePath)}`,
});

describe('tool/research-vault', () => {
  it('单文件校验失败时保存 partial，且不把扫描声明为完整', async () => {
    const base = await buildTestContext({
      clock: () => new Date('2026-08-01T00:00:00.000Z'),
    });
    const ctx = {
      ...base,
      researchVault: vault('---\nluoome_type: research-topic\nluoome_id: topic_bad\n---\n'),
    };

    const result = await syncResearchVaultTool.execute({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ status: 'partial', invalid: 1, scanned: 1 });
    expect((await ctx.repos.researchVaultSyncRun.list('vault-test', 1))[0]).toMatchObject({
      status: 'partial',
      invalid: 1,
    });
  });

  it('Vault 扫描失败时把 running 更新为 failed', async () => {
    const base = await buildTestContext({
      clock: () => new Date('2026-08-01T00:00:00.000Z'),
    });
    const ctx = { ...base, researchVault: vault('', new Error('vault offline')) };

    const result = await syncResearchVaultTool.execute({}, ctx);

    expect(result.ok).toBe(false);
    expect((await ctx.repos.researchVaultSyncRun.list('vault-test', 1))[0]).toMatchObject({
      status: 'failed',
      error: 'vault offline',
    });
  });

  it('Vault 未挂载时仍可读取已有索引并报告 unavailable', async () => {
    const ctx = await buildTestContext();
    const now = new Date('2026-08-01T00:00:00.000Z');
    await ctx.repos.researchIndex.applyIndexBatch({
      vaultId: 'vault-test',
      completeness: 'complete',
      topics: [
        {
          id: 'topic_existing',
          title: '已有研究',
          kind: 'custom',
          tags: [],
          vaultId: 'vault-test',
          relativePath: 'Research/existing.md',
          contentHash: 'a'.repeat(64),
          fileModifiedAt: now,
          indexedAt: now,
          availability: 'available',
        },
      ],
      documents: [],
      topicDocuments: [],
      subjectLinks: [],
      chunks: [],
      seenTopicIds: new Set(['topic_existing']),
      seenDocumentIds: new Set(),
      indexedAt: now,
    });

    const result = await listResearchTopicsTool.execute({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.topics).toHaveLength(1);
    expect(result.data.indexStatus).toMatchObject({
      vaultId: 'vault-test',
      freshness: 'unavailable',
    });
  });
});
