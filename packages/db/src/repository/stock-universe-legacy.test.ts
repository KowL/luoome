import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDrizzleRepos } from '../client.js';

const columnNames = (path: string): string[] => {
  const raw = new Database(path, { readonly: true });
  try {
    return raw
      .prepare('PRAGMA table_info(stock_universe_snapshot_members)')
      .all()
      .map((row) => String((row as { name: string }).name));
  } finally {
    raw.close();
  }
};

describe('T35 旧 snapshot 行迁移（Bun SQLite）', () => {
  it('旧表无属性列：启动迁移补列但旧行保持 NULL=unknown，重复启动幂等', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-t35-legacy-'));
    const path = join(dir, 'luoome.db');
    try {
      createDrizzleRepos(path).close();
      // 模拟 T35 之前的表结构：删掉四个属性列，并写入一条只有身份的旧成员行。
      const raw = new Database(path);
      for (const column of ['listing_status', 'industry', 'list_date', 'delist_date']) {
        raw.exec(`ALTER TABLE stock_universe_snapshot_members DROP COLUMN ${column}`);
      }
      raw
        .prepare('INSERT INTO stock_universe_snapshot_members (sync_id, stock_id) VALUES (?, ?)')
        .run('sync-legacy', '600519.SH');
      raw.close();

      const first = createDrizzleRepos(path);
      try {
        expect(columnNames(path)).toEqual([
          'sync_id',
          'stock_id',
          'listing_status',
          'industry',
          'list_date',
          'delist_date',
        ]);
        expect(await first.repos.stockUniverse.listSnapshotMemberFacts('sync-legacy')).toEqual([
          {
            stockId: '600519.SH',
            code: '600519',
            exchange: 'SH',
            listingStatus: 'unknown',
          },
        ]);
        // 旧行不回落当前 stocks：没有 stocks 行时成员仍返回，name 缺省。
        expect(
          (await first.repos.stockUniverse.listSnapshotMembers('sync-legacy')).map(
            (stock) => stock.id,
          ),
        ).toEqual(['600519.SH']);
      } finally {
        first.close();
      }

      const second = createDrizzleRepos(path);
      try {
        expect(await second.repos.stockUniverse.listSnapshotMemberFacts('sync-legacy')).toEqual([
          {
            stockId: '600519.SH',
            code: '600519',
            exchange: 'SH',
            listingStatus: 'unknown',
          },
        ]);
      } finally {
        second.close();
      }
      expect(columnNames(path)).toEqual([
        'sync_id',
        'stock_id',
        'listing_status',
        'industry',
        'list_date',
        'delist_date',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
