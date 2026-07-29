import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createDrizzleRepos } from '../client.js';
import { seedLegacyStrategyWatchlistFixture } from '../testing/legacy-strategy-watchlist-fixture.js';

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
});
