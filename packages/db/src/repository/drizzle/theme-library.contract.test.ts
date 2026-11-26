import { describe, expect, it } from 'bun:test';
import type { ThemeLibrarySeedTheme } from '@luoome/core';
import { createDrizzleRepos } from '../../client.js';

const at = (time: string): Date => new Date(`2026-11-25T${time}+08:00`);

const seedTheme = (input: {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly stockIds: readonly string[];
  readonly vendorCode?: string;
}): ThemeLibrarySeedTheme => ({
  id: input.id,
  name: input.name,
  sortOrder: input.sortOrder,
  sources: [
    {
      vendorCode: input.vendorCode ?? '885728.TI',
      sectorId: `concept-${input.id}`,
      name: `${input.name}概念`,
    },
  ],
  stockIds: [...input.stockIds],
});

const SEED = {
  themes: [
    seedTheme({
      id: 'ai-computing',
      name: 'AI与算力',
      sortOrder: 0,
      stockIds: ['600519.SH', '000001.SZ'],
    }),
    seedTheme({
      id: 'semiconductor',
      name: '半导体',
      sortOrder: 1,
      stockIds: ['300750.SZ'],
      vendorCode: '885756.TI',
    }),
  ],
  skipped: [],
};

describe('ThemeLibraryRepository', () => {
  it('imports atomically, is idempotent by importId, and re-import only fills missing themes', async () => {
    const handle = createDrizzleRepos(':memory:');
    const repos = handle.repos;
    try {
      const first = await repos.themeLibrary.importSeed({
        importId: 'import-1',
        source: 'fuyao',
        appliedAt: at('09:00'),
        seed: SEED,
      });
      expect(first).toMatchObject({
        status: 'imported',
        createdThemes: 2,
        createdMembers: 3,
        createdSources: 2,
      });
      expect(await repos.themeLibrary.listThemes({ state: 'all' })).toHaveLength(2);
      expect(await repos.themeLibrary.listMembers()).toHaveLength(3);

      const replay = await repos.themeLibrary.importSeed({
        importId: 'import-1',
        source: 'fuyao',
        appliedAt: at('09:05'),
        seed: SEED,
      });
      expect(replay).toEqual(first);
      expect(await repos.themeLibrary.listMembers()).toHaveLength(3);

      await repos.themeLibrary.removeMember({
        themeId: 'ai-computing',
        stockId: '600519.SH',
        at: at('09:10'),
      });
      await repos.themeLibrary.renameTheme({
        themeId: 'ai-computing',
        name: 'AI 算力（人工）',
        at: at('09:11'),
      });
      await repos.themeLibrary.archiveTheme({ themeId: 'semiconductor', at: at('09:12') });
      await repos.themeLibrary.reorderThemes({
        themeIds: ['semiconductor', 'ai-computing'],
        at: at('09:13'),
      });

      const second = await repos.themeLibrary.importSeed({
        importId: 'import-2',
        source: 'fuyao',
        appliedAt: at('09:20'),
        seed: {
          themes: [
            ...SEED.themes,
            seedTheme({
              id: 'robotics',
              name: '机器人',
              sortOrder: 2,
              stockIds: ['300750.SZ'],
              vendorCode: '885517.TI',
            }),
          ],
          skipped: [],
        },
      });
      expect(second).toMatchObject({ status: 'imported', createdThemes: 1, createdMembers: 1 });

      const themes = await repos.themeLibrary.listThemes({ state: 'all' });
      expect(themes.map((theme) => [theme.id, theme.name, theme.state, theme.sortOrder])).toEqual([
        ['semiconductor', '半导体', 'archived', 0],
        ['ai-computing', 'AI 算力（人工）', 'active', 1],
        ['robotics', '机器人', 'active', 2],
      ]);
      const effective = await repos.themeLibrary.listMembers({
        themeIds: ['ai-computing'],
        at: at('09:30'),
      });
      expect(effective.map((member) => member.stockId)).toEqual(['000001.SZ']);
      expect(await repos.themeLibrary.listMembers({ themeIds: ['ai-computing'] })).toHaveLength(2);
    } finally {
      handle.close();
    }
  });

  it('keeps effective intervals for removal and re-add, and filters by the requested instant', async () => {
    const handle = createDrizzleRepos(':memory:');
    const repos = handle.repos;
    try {
      await repos.themeLibrary.importSeed({
        importId: 'import-1',
        source: 'fuyao',
        appliedAt: at('09:00'),
        seed: { themes: [SEED.themes[0]!], skipped: [] },
      });
      expect(
        await repos.themeLibrary.removeMember({
          themeId: 'ai-computing',
          stockId: '600519.SH',
          at: at('10:00'),
        }),
      ).toBe(true);
      expect(
        await repos.themeLibrary.removeMember({
          themeId: 'ai-computing',
          stockId: '600519.SH',
          at: at('10:01'),
        }),
      ).toBe(false);
      await repos.themeLibrary.addMembers({
        themeId: 'ai-computing',
        stockIds: ['600519.SH'],
        origin: 'manual',
        at: at('11:00'),
      });
      const intervals = await repos.themeLibrary.listMembers({ themeIds: ['ai-computing'] });
      const stockIntervals = intervals.filter((member) => member.stockId === '600519.SH');
      expect(stockIntervals).toHaveLength(2);
      expect(
        stockIntervals.map((entry) => [entry.origin, entry.effectiveFrom, entry.effectiveTo]),
      ).toEqual([
        ['seed', at('09:00'), at('10:00')],
        ['manual', at('11:00'), null],
      ]);
      expect(
        (
          await repos.themeLibrary.listMembers({
            themeIds: ['ai-computing'],
            at: at('10:30'),
          })
        ).map((entry) => entry.stockId),
      ).toEqual(['000001.SZ']);
      expect(
        (
          await repos.themeLibrary.listMembers({
            themeIds: ['ai-computing'],
            at: at('11:30'),
          })
        ).map((entry) => entry.stockId),
      ).toEqual(['000001.SZ', '600519.SH']);
    } finally {
      handle.close();
    }
  });

  it('skips seeded themes whose name already exists and rejects malformed reorder lists', async () => {
    const handle = createDrizzleRepos(':memory:');
    const repos = handle.repos;
    try {
      await repos.themeLibrary.createTheme({ id: 'manual-1', name: 'AI与算力', at: at('09:00') });
      const summary = await repos.themeLibrary.importSeed({
        importId: 'import-1',
        source: 'fuyao',
        appliedAt: at('09:10'),
        seed: SEED,
      });
      expect(summary.status).toBe('imported');
      expect(summary.skippedThemes).toEqual([
        { themeId: 'ai-computing', name: 'AI与算力', reason: 'name_conflict' },
      ]);
      expect(summary.createdThemes).toBe(1);
      await expect(
        repos.themeLibrary.reorderThemes({ themeIds: ['manual-1'], at: at('09:20') }),
      ).rejects.toThrow('题材顺序列表必须覆盖当前全部题材');
    } finally {
      handle.close();
    }
  });
});
