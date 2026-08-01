import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsidianVaultAdapter, parseResearchMarkdown } from './obsidian.js';

describe('ObsidianVaultAdapter', () => {
  it('parses flat YAML lists and rejects paths outside the vault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luoome-vault-'));
    await writeFile(join(root, 'note.md'), '---\nluoome_id: doc_x\ntags:\n  - luoome/research\n---\n正文');
    const adapter = new ObsidianVaultAdapter({ vaultPath: root, researchRoot: '.' });
    expect(parseResearchMarkdown(await adapter.readText({ relativePath: 'note.md', maxBytes: 1000 })).frontmatter.tags).toEqual(['luoome/research']);
    await expect(adapter.readText({ relativePath: '../outside.md', maxBytes: 1000 })).rejects.toThrow();
    expect(adapter.buildOpenUri('中文 #1.md')).toContain('%E4%B8%AD');
  });
});
