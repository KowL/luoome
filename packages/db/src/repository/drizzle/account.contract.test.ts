import { describe, expect, it } from 'bun:test';
import { createDefaultAccount, money } from '@luoome/core';
import { createDrizzleRepos } from '../../client.js';
import { createInMemoryRepos } from '../memory/index.js';

for (const mode of ['memory', 'drizzle'] as const) {
  describe(`AccountRepository [${mode}]`, () => {
    it('atomically ensures one default and preserves an existing nondefault id and ledger', async () => {
      const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
      const repos = handle?.repos ?? createInMemoryRepos();
      try {
        const candidate = createDefaultAccount(new Date('2026-10-11T01:00:00Z'));
        const existing = {
          ...candidate,
          id: 'existing-main',
          name: '原账户',
          initialCapital: money(100),
          cashBalance: money(45),
        };
        await repos.account.save(existing);
        const results = await Promise.all(
          Array.from({ length: 10 }, () => repos.account.ensureSingleDefault(candidate)),
        );
        expect(results).toEqual(Array.from({ length: 10 }, () => existing));
        expect(await repos.account.list()).toEqual([existing]);
      } finally {
        handle?.close();
      }
    });

    it('creates once from an empty store and refuses multiple accounts without modifying any', async () => {
      const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
      const repos = handle?.repos ?? createInMemoryRepos();
      try {
        const candidate = createDefaultAccount(new Date('2026-10-11T01:00:00Z'));
        const results = await Promise.all(
          Array.from({ length: 10 }, () => repos.account.ensureSingleDefault(candidate)),
        );
        expect(results).toEqual(Array.from({ length: 10 }, () => candidate));
        expect(await repos.account.list()).toEqual([candidate]);
        await repos.account.save({ ...candidate, id: 'second' });
        const before = await repos.account.list();
        await expect(repos.account.ensureSingleDefault(candidate)).rejects.toThrow(
          '一个默认投资账户',
        );
        expect(await repos.account.list()).toEqual(before);
      } finally {
        handle?.close();
      }
    });

    it('renames without overwriting financial changes made after the caller read the account', async () => {
      const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
      const repos = handle?.repos ?? createInMemoryRepos();
      try {
        const original = createDefaultAccount(new Date('2026-10-11T01:00:00Z'));
        await repos.account.save(original);
        const changed = { ...original, cashBalance: money(800) };
        await repos.account.save(changed);
        expect(await repos.account.updateName(original.id, '修改名称')).toEqual({
          ...changed,
          name: '修改名称',
        });
        expect(await repos.account.updateName('absent', '不存在')).toBeNull();
      } finally {
        handle?.close();
      }
    });
  });
}
