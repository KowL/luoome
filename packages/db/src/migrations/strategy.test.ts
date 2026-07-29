import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strategyDefinitionHash } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { createDrizzleRepos } from '../client.js';
import { seedLegacyStrategyWatchlistFixture } from '../testing/legacy-strategy-watchlist-fixture.js';
import { listAppliedSchemaMigrations } from './runner.js';

const tableCount = (db: Database, table: string): number =>
  db.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ??
  0;

describe('20260729_02_migrate_tactics', () => {
  it('Tactic/Signal 无损迁移、重复启动不增行且旧读取路径保持', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-strategy-w1-'));
    const dbPath = path.join(dir, 'legacy.sqlite');
    try {
      const legacy = new Database(dbPath);
      seedLegacyStrategyWatchlistFixture(legacy);
      legacy.exec(`
        INSERT INTO tactic_signals VALUES
          ('fixture-signal-duplicate', 'fixture-builtin', 'Fixture builtin', 'momentum',
           '600519.SH', 1785340800000, 91, 'bullish', '["duplicate"]',
           '{"expression":"1 == 1","result":true}');
      `);
      legacy.close();

      const first = createDrizzleRepos(dbPath);
      const strategies = await first.repos.strategy.list();
      expect(strategies).toHaveLength(2);
      for (const strategy of strategies) {
        const versions = await first.repos.strategy.listVersions(strategy.id);
        expect(versions).toHaveLength(1);
        expect(versions[0]?.definitionHash).toBe(
          strategyDefinitionHash(
            versions[0]?.definition as NonNullable<(typeof versions)[0]>['definition'],
          ),
        );
        expect(strategy.currentVersionId).toBe(versions[0]?.id);
      }
      expect(await first.repos.strategyRun.signalsByStrategy('fixture-builtin')).toHaveLength(1);
      first.close();

      const raw = new Database(dbPath);
      // legacy 旧表行保留可读（repo 层已下掉，用 raw SQL 验证旧读取路径）
      expect(
        raw
          .query<{ readonly count: number }, []>(
            `SELECT count(*) AS count FROM tactics WHERE id = 'fixture-user'`,
          )
          .get()?.count,
      ).toBe(1);
      expect(tableCount(raw, 'strategies')).toBe(2);
      expect(tableCount(raw, 'strategy_versions')).toBe(2);
      expect(tableCount(raw, 'strategy_runs')).toBe(2);
      expect(tableCount(raw, 'strategy_signals')).toBe(2);
      expect(
        raw
          .query<{ readonly count: number }, []>(`
            SELECT count(*) AS count
            FROM strategy_signals s
            LEFT JOIN strategies st ON st.id = s.strategy_id
            LEFT JOIN strategy_versions v ON v.id = s.strategy_version_id
            LEFT JOIN strategy_runs r ON r.id = s.run_id
            WHERE st.id IS NULL OR v.id IS NULL OR r.id IS NULL
          `)
          .get()?.count,
      ).toBe(0);
      const migrations = listAppliedSchemaMigrations(raw);
      expect(migrations.map((migration) => migration.id)).toEqual([
        '20260729_01_strategy_tables',
        '20260729_02_migrate_tactics',
        '20260729_03_watchlist_tables',
        '20260729_04_migrate_stock_groups',
        '20260729_05_alert_plan_tables',
        '20260729_06_migrate_stock_pools',
      ]);
      expect(migrations[1]?.details).toMatchObject({
        tacticsScanned: 2,
        strategiesWritten: 2,
        signalsScanned: 3,
        signalsWritten: 2,
        signalMerges: 1,
        idConflicts: 0,
      });
      raw.close();

      const second = createDrizzleRepos(dbPath);
      second.close();
      const afterRerun = new Database(dbPath);
      expect(tableCount(afterRerun, 'strategies')).toBe(2);
      expect(tableCount(afterRerun, 'strategy_signals')).toBe(2);
      afterRerun.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目标 Strategy id 已占用时使用 strategy- 前缀并记录映射', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-strategy-w1-conflict-'));
    const dbPath = path.join(dir, 'legacy.sqlite');
    try {
      const legacy = new Database(dbPath);
      seedLegacyStrategyWatchlistFixture(legacy);
      legacy.exec(`
        CREATE TABLE strategies (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, owner TEXT NOT NULL,
          status TEXT NOT NULL, current_version_id TEXT, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO strategies VALUES
          ('fixture-user', 'Existing', 'existing strategy', 'user', 'draft', NULL,
           1785254400000, 1785254400000);
      `);
      legacy.close();

      const handle = createDrizzleRepos(dbPath);
      expect(await handle.repos.strategy.findById('strategy-fixture-user')).not.toBeNull();
      handle.close();

      const raw = new Database(dbPath);
      const migration = listAppliedSchemaMigrations(raw).find(
        (item) => item.id === '20260729_02_migrate_tactics',
      );
      expect(migration?.details).toMatchObject({
        idConflicts: 1,
        mappings: { 'fixture-user': 'strategy-fixture-user' },
      });
      raw.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
