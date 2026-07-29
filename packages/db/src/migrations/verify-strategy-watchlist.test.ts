import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createDrizzleRepos } from '../client.js';
import { seedLegacyStrategyWatchlistFixture } from '../testing/legacy-strategy-watchlist-fixture.js';
import {
  verifyLegacyStrategyWatchlistBaseline,
  verifyLegacyStrategyWatchlistDatabase,
  verifyStrategyWatchlistDatabase,
} from './verify-strategy-watchlist.js';

const sha256File = (filePath: string): string =>
  createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

describe('strategy-watchlist migration verify baseline', () => {
  it('旧库 fixture 生成稳定的成员集合与 watch golden，且 verify 不写数据库', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-strategy-watchlist-w0-'));
    const dbPath = path.join(dir, 'legacy.sqlite');
    try {
      const db = new Database(dbPath);
      seedLegacyStrategyWatchlistFixture(db);
      const direct = verifyLegacyStrategyWatchlistBaseline(db);
      db.close();

      const before = sha256File(dbPath);
      const readonlyReport = verifyLegacyStrategyWatchlistDatabase(dbPath);
      const after = sha256File(dbPath);
      expect(after).toBe(before);
      expect(readonlyReport).toEqual(direct);
      expect(readonlyReport).toMatchInlineSnapshot(`
        {
          "counts": {
            "groupMemberSnapshots": 5,
            "stockGroups": 4,
            "stockPools": 1,
            "tacticSignals": 2,
            "tactics": 2,
            "watchRuleStates": 2,
            "watchTriggers": 2,
          },
          "currentMembersByGroup": {
            "fixture-formula": [
              "002594.SZ",
              "600519.SH",
            ],
            "fixture-holdings": [
              "600000.SH",
            ],
            "fixture-llm": [
              "600000.SH",
            ],
            "fixture-manual": [
              "002594.SZ",
              "600519.SH",
            ],
          },
          "orphanReferences": [],
          "refreshIdsByGroup": {
            "fixture-formula": [
              "formula-refresh-1",
              "formula-refresh-2",
            ],
            "fixture-holdings": [],
            "fixture-llm": [
              "llm-refresh-1",
              "llm-refresh-2",
            ],
            "fixture-manual": [],
          },
          "resolverCounts": {
            "formula": 1,
            "holdings": 1,
            "llm": 1,
            "manual": 1,
            "unknown": 0,
          },
          "schemaVersion": 1,
          "watchGolden": {
            "enabledPoolIds": [
              "fixture-pool",
            ],
            "ruleStates": [
              {
                "active": false,
                "poolId": "fixture-pool",
                "ruleId": "rule-price",
                "stockId": "002594.SZ",
              },
              {
                "active": true,
                "poolId": "fixture-pool",
                "ruleId": "rule-tactic",
                "stockId": "600519.SH",
              },
            ],
            "triggers": [
              {
                "deliveryStatus": "sent",
                "id": "fixture-trigger-sent",
                "poolId": "fixture-pool",
                "ruleId": "rule-tactic",
                "stockId": "600519.SH",
              },
              {
                "deliveryStatus": "suppressed-cooldown",
                "id": "fixture-trigger-suppressed",
                "poolId": "fixture-pool",
                "ruleId": "rule-price",
                "stockId": "002594.SZ",
              },
            ],
          },
        }
      `);

      const handle = createDrizzleRepos(dbPath);
      try {
        // legacy repo 层已下掉，旧表可读性用 raw SQL 验证
        expect(
          handle.db.all<{ id: string }>(sql`SELECT id FROM tactics WHERE id = 'fixture-user'`),
        ).toHaveLength(1);
        expect(
          handle.db.all<{ id: string }>(
            sql`SELECT id FROM tactic_signals WHERE stock_id = '002594.SZ'`,
          ),
        ).toHaveLength(1);
        expect(handle.db.all<{ id: string }>(sql`SELECT id FROM stock_groups`)).toHaveLength(4);
        // currentMembers 语义 = 最新 refreshId 那一批（按 created_at 最新判定）
        expect(
          handle.db
            .all<{ stock_id: string }>(sql`
              SELECT stock_id FROM group_member_snapshots
              WHERE group_id = 'fixture-formula' AND refresh_id = (
                SELECT refresh_id FROM group_member_snapshots
                WHERE group_id = 'fixture-formula'
                ORDER BY created_at DESC LIMIT 1
              )
              ORDER BY stock_id
            `)
            .map((row) => row.stock_id),
        ).toEqual(['002594.SZ', '600519.SH']);
        expect(
          handle.db.all<{ id: string }>(sql`SELECT id FROM stock_pools WHERE id = 'fixture-pool'`),
        ).toHaveLength(1);
        expect(await handle.repos.watchTrigger.listByPool('fixture-pool')).toHaveLength(2);
        expect(await handle.repos.watchRuleState.listByPool('fixture-pool')).toHaveLength(2);
      } finally {
        handle.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('迁移后 verify 只读校验新旧成员集合、映射与引用完整性', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-strategy-watchlist-w3-'));
    const dbPath = path.join(dir, 'migrated.sqlite');
    try {
      const db = new Database(dbPath);
      seedLegacyStrategyWatchlistFixture(db);
      db.close();

      const handle = createDrizzleRepos(dbPath);
      handle.close();

      const before = sha256File(dbPath);
      const report = verifyStrategyWatchlistDatabase(dbPath);
      const after = sha256File(dbPath);

      expect(after).toBe(before);
      expect(report.watchlist.readyForW4).toBe(true);
      expect(report.alertPlan.readyForW5).toBe(true);
      expect(report.alertPlan.ruleDifferences).toEqual([]);
      expect(report.alertPlan.orphanReferences).toEqual([]);
      expect(report.watchlist.memberSetDifferences).toEqual([]);
      expect(report.watchlist.orphanReferences).toEqual([]);
      expect(report.watchlist.counts).toEqual({
        watchlists: 4,
        members: 8,
        sources: 6,
        syncRuns: 4,
        snapshots: 7,
      });
      expect(Object.keys(report.watchlist.mappings).sort()).toEqual([
        'fixture-formula',
        'fixture-holdings',
        'fixture-llm',
        'fixture-manual',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
