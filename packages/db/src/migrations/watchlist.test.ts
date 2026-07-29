import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createDrizzleRepos } from '../client.js';
import { seedLegacyStrategyWatchlistFixture } from '../testing/legacy-strategy-watchlist-fixture.js';
import { listAppliedSchemaMigrations } from './runner.js';
import { verifyLegacyStrategyWatchlistBaseline } from './verify-strategy-watchlist.js';

describe('20260729_04_migrate_stock_groups', () => {
  it('四种 resolver、刷新历史和当前成员无损迁移且重复启动幂等', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-watchlist-w3-'));
    const dbPath = path.join(dir, 'legacy.sqlite');
    try {
      const legacy = new Database(dbPath);
      seedLegacyStrategyWatchlistFixture(legacy);
      const baseline = verifyLegacyStrategyWatchlistBaseline(legacy);
      legacy.close();

      const first = createDrizzleRepos(dbPath);
      expect(await first.repos.watchlist.list()).toHaveLength(4);
      for (const [groupId, expected] of Object.entries(baseline.currentMembersByGroup)) {
        expect(
          (await first.repos.watchlistMember.listMembers(groupId)).map((member) => member.stockId),
        ).toEqual(expected);
      }
      const formulaMembers = await first.repos.watchlistMember.listMembers('fixture-formula');
      for (const member of formulaMembers) {
        expect(
          await first.repos.watchlistMember.currentSource(member.id, 'strategy:fixture-builtin'),
        ).not.toBeNull();
      }
      expect(
        await first.repos.watchlistMember.listSnapshots(
          'legacy-group-refresh:fixture-formula:formula-refresh-2',
        ),
      ).toHaveLength(3);
      first.close();

      const raw = new Database(dbPath);
      expect(
        raw.query<{ count: number }, []>('SELECT count(*) AS count FROM watchlists').get()?.count,
      ).toBe(4);
      expect(
        raw.query<{ count: number }, []>('SELECT count(*) AS count FROM watchlist_sync_runs').get()
          ?.count,
      ).toBe(4);
      expect(
        raw.query<{ count: number }, []>('SELECT count(*) AS count FROM membership_snapshots').get()
          ?.count,
      ).toBe(7);
      const details = listAppliedSchemaMigrations(raw).find(
        (migration) => migration.id === '20260729_04_migrate_stock_groups',
      )?.details;
      expect(details).toMatchObject({
        groupsScanned: 4,
        watchlistsWritten: 4,
        runsWritten: 4,
        snapshotsWritten: 7,
        warnings: [],
      });
      raw.close();

      const second = createDrizzleRepos(dbPath);
      second.close();
      const rerun = new Database(dbPath);
      expect(
        rerun.query<{ count: number }, []>('SELECT count(*) AS count FROM watchlists').get()?.count,
      ).toBe(4);
      expect(
        rerun
          .query<{ count: number }, []>('SELECT count(*) AS count FROM membership_snapshots')
          .get()?.count,
      ).toBe(7);
      rerun.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
