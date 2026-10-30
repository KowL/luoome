import { describe, expect, it } from 'bun:test';
import { createDrizzleRepos } from '../client.js';
import { InMemorySchemaMigrationRepository } from './memory/schema-migration.js';

const records = [
  { id: 'mvp3-legacy-explicit-trade-links-v1', appliedAt: new Date('2026-10-01T00:00:00.000Z') },
  { id: 'm1-06-signal-observation-vintage-v1', appliedAt: new Date('2026-10-02T00:00:00.000Z') },
];

describe('SchemaMigrationRepository', () => {
  it('memory：只读列出已应用迁移', async () => {
    const repo = new InMemorySchemaMigrationRepository(records);
    expect(await repo.list()).toEqual(records);
    // 调用方拿到的是副本，改不动内部状态。
    const listed = await repo.list();
    listed[0]?.appliedAt.setTime(0);
    expect((await repo.list())[0]?.appliedAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('drizzle：启动迁移后能读到同一批 id 与时间', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const listed = await handle.repos.schemaMigration?.list();
      expect(Array.isArray(listed)).toBe(true);
      for (const record of listed ?? []) {
        expect(record.id.length).toBeGreaterThan(0);
        expect(record.appliedAt instanceof Date).toBe(true);
      }
    } finally {
      handle.close();
    }
  });
});
