import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createDrizzleRepos } from '../client.js';
import { seedLegacyStrategyWatchlistFixture } from '../testing/legacy-strategy-watchlist-fixture.js';
import { listAppliedSchemaMigrations } from './runner.js';

describe('20260729_06_migrate_stock_pools', () => {
  it('迁移 plan/rule/trigger/state 引用并保持重复启动幂等', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-alert-plan-w4-'));
    const dbPath = path.join(dir, 'legacy.sqlite');
    try {
      const legacy = new Database(dbPath);
      seedLegacyStrategyWatchlistFixture(legacy);
      legacy.close();

      const first = createDrizzleRepos(dbPath);
      const plan = await first.repos.alertPlan.findById('fixture-pool');
      expect(plan).toMatchObject({
        id: 'fixture-pool',
        watchlistId: 'fixture-formula',
        enabled: true,
      });
      expect(plan?.rules[0]).toMatchObject({
        id: 'rule-tactic',
        kind: 'strategy-signal',
        strategyId: 'fixture-builtin',
      });
      first.close();

      const second = createDrizzleRepos(dbPath);
      expect(await second.repos.alertPlan.list()).toHaveLength(1);
      const trigger = await second.repos.watchTrigger.findById('fixture-trigger-sent');
      expect(trigger?.alertPlanId).toBe('fixture-pool');
      expect((await second.repos.watchRuleState.listByPool('fixture-pool'))[0]?.alertPlanId).toBe(
        'fixture-pool',
      );
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('损坏 rules JSON 的 pool 禁用落地，非法 id 的 pool 跳过并记 warning', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-alert-plan-dirty-'));
    const dbPath = path.join(dir, 'legacy.sqlite');
    try {
      const legacy = new Database(dbPath);
      seedLegacyStrategyWatchlistFixture(legacy);
      legacy.exec(`
        INSERT INTO stock_pools VALUES
          ('broken-rules', 'Broken rules', NULL, NULL, 'fixture-manual', '{oops',
           30, 1, 1785254400000, 1785340800000, 'ANY', 'on-enter', NULL, 20, 0),
          ('Bad Pool', 'Bad id', NULL, NULL, 'fixture-manual',
           '[{"id":"r","kind":"price-change","pct":0.03,"direction":"up"}]',
           30, 1, 1785254400000, 1785340800000, 'ANY', 'on-enter', NULL, 20, 0);
      `);
      legacy.close();

      const handle = createDrizzleRepos(dbPath);
      const broken = await handle.repos.alertPlan.findById('broken-rules');
      expect(broken).toMatchObject({ enabled: false, rules: [] });
      expect(await handle.repos.alertPlan.findById('Bad Pool')).toBeNull();
      handle.close();

      const raw = new Database(dbPath);
      const details = listAppliedSchemaMigrations(raw).find(
        (migration) => migration.id === '20260729_06_migrate_stock_pools',
      )?.details;
      expect(details).toMatchObject({ poolsScanned: 3, alertPlansWritten: 2 });
      expect(details?.warnings).toEqual([
        'pool id 不符合统一 slug 规则，已跳过: "Bad Pool"',
        'pool broken-rules rules JSON 损坏，目标已禁用',
      ]);
      raw.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
