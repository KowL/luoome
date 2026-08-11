import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { money } from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import { exportDataArchive, importDataArchive } from './data-transfer.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const databasePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'luoome-transfer-'));
  dirs.push(dir);
  return join(dir, 'luoome.db');
};

describe('data transfer', () => {
  it('按分类导出并合并导入', async () => {
    const sourcePath = databasePath();
    const source = createDrizzleRepos(sourcePath);
    await source.repos.account.save({
      id: 'account-1',
      name: '主账户',
      kind: 'real',
      currency: 'CNY',
      initialCapital: money(1000),
      createdAt: new Date('2026-08-11T00:00:00Z'),
    });
    source.close();

    const archive = exportDataArchive(sourcePath, ['portfolio']);
    expect(archive.categories).toEqual(['portfolio']);
    expect(archive.tables.accounts).toHaveLength(1);
    expect(archive.tables.chat_sessions).toBeUndefined();

    const targetPath = databasePath();
    const target = createDrizzleRepos(targetPath);
    target.close();
    const result = importDataArchive(targetPath, archive);
    expect(result.imported).toBeGreaterThanOrEqual(1);
    const reopened = createDrizzleRepos(targetPath);
    expect((await reopened.repos.account.findById('account-1'))?.name).toBe('主账户');
    reopened.close();
  });

  it('拒绝未知表且不写入任何行', () => {
    const path = databasePath();
    const handle = createDrizzleRepos(path);
    handle.close();
    expect(() =>
      importDataArchive(path, {
        format: 'luoome-data',
        version: 1,
        exportedAt: new Date().toISOString(),
        categories: ['portfolio'],
        tables: { secrets: [{ token: 'nope' }] },
      }),
    ).toThrow('不允许导入');
  });
});
