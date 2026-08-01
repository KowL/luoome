import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ObsidianVaultAdapter, parseResearchMarkdown } from './obsidian.js';

const makeVault = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'luoome-vault-'));
  await mkdir(join(root, 'Research'), { recursive: true });
  return root;
};

describe('ObsidianVaultAdapter', () => {
  it('parses flat YAML lists and reads a safe relative path', async () => {
    const root = await makeVault();
    await writeFile(
      join(root, 'Research', 'note.md'),
      '---\nluoome_id: doc_x\ntags:\n  - luoome/research\n---\n正文',
    );
    const adapter = new ObsidianVaultAdapter({ vaultPath: root });

    const parsed = parseResearchMarkdown(
      await adapter.readText({ relativePath: 'Research/note.md', maxBytes: 1000 }),
    );

    expect(parsed.frontmatter.tags).toEqual(['luoome/research']);
    expect(parsed.body).toBe('正文');
    await expect(
      adapter.readText({ relativePath: '../outside.md', maxBytes: 1000 }),
    ).rejects.toThrow('unsafe relative path');
    expect(adapter.buildOpenUri('中文 #1.md')).toContain('%E4%B8%AD');
  });

  it('rejects a file symlink that escapes the vault', async () => {
    const root = await makeVault();
    const outside = join(root, '..', `secret-${Date.now()}.md`);
    await writeFile(outside, 'outside-secret');
    await symlink(outside, join(root, 'Research', 'link.md'));
    const adapter = new ObsidianVaultAdapter({ vaultPath: root });

    await expect(
      adapter.readText({ relativePath: 'Research/link.md', maxBytes: 1000 }),
    ).rejects.toThrow('path escapes vault');
    expect(await adapter.scan()).toEqual([]);
  });

  it('creates managed documents atomically and refuses overwrite', async () => {
    const root = await makeVault();
    const adapter = new ObsidianVaultAdapter({ vaultPath: root });

    const entry = await adapter.createManagedDocument({
      relativePath: 'Research/Luoome/topic.md',
      content: '# Topic',
    });

    expect(entry.relativePath).toBe('Research/Luoome/topic.md');
    expect(await readFile(join(root, entry.relativePath), 'utf8')).toBe('# Topic');
    await expect(
      adapter.createManagedDocument({
        relativePath: 'Research/Luoome/topic.md',
        content: 'overwrite',
      }),
    ).rejects.toThrow('target already exists');
    await expect(
      adapter.createManagedDocument({ relativePath: 'Research/unmanaged.md', content: 'x' }),
    ).rejects.toThrow('managed writes');
  });

  it('rejects broad and reserved roots', async () => {
    expect(() => new ObsidianVaultAdapter({ vaultPath: '/' })).toThrow('too broad');
  });
});
