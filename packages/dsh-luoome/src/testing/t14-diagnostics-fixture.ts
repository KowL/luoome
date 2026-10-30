// T14 诊断验收的合成坏数据 fixture（Bun + bun:sqlite 建库）。
//
// 三类坏数据一次造齐：
//   1. 缺行情 —— 不写任何 price_snapshots / daily_bars，但账户有持仓（关注标的非空）；
//   2. 迁移未完成 —— 删掉 schema_migrations 里的一条已知迁移行；
//   3. 连接失败 —— 写一条 status=failed 的 stock_universe_sync_runs。
//
// 用法：bun --no-env-file packages/dsh-luoome/src/testing/t14-diagnostics-fixture.ts seed <home> '<ownerJson>'

import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { TEST_HOLDINGS, TEST_STOCKS } from '@luoome/adapters/testing';
import { money } from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';

const [, , command, home, ownerJson] = process.argv;
if (command !== 'seed' || !home || !ownerJson) throw new Error("usage: seed <home> '<ownerJson>'");
const owner = JSON.parse(ownerJson) as { userId: string; accountId: string };

const handle = createDrizzleRepos(join(home, 'luoome.db'));
try {
  await handle.repos.account.save({
    id: owner.accountId,
    name: '诊断验收账户',
    currency: 'CNY',
    initialCapital: money(1_000_000),
    cashBalance: money(1_000_000),
    kind: 'real',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
  });
  const stock = TEST_STOCKS[0];
  const holding = TEST_HOLDINGS[0];
  if (stock === undefined || holding === undefined) throw new Error('missing test fixtures');
  await handle.repos.stock.save(stock);
  await handle.repos.holding.save({
    ...holding,
    accountId: owner.accountId,
    stockId: stock.id,
  });
} finally {
  handle.close();
}

const db = new Database(join(home, 'luoome.db'));
try {
  // 迁移未完成不在这里造：插件启动时 ensureSchema 会把缺的迁移补回去，
  // 必须等进程起来之后再删（见验收脚本），否则等于没造。
  // 连接失败：最近一次股票库同步失败。
  db.prepare(
    `INSERT INTO stock_universe_sync_runs
      (id, source, coverage, status, started_at, finished_at, observed_at, reported_total,
       observed_count, created_stocks, updated_stocks, reactivated, marked_missing,
       error_kind, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'diag-sync-failed',
    'eastmoney',
    'CN_A_SHARES_SH_SZ',
    'failed',
    new Date('2026-10-30T03:59:00.000Z').getTime(),
    new Date('2026-10-30T04:00:00.000Z').getTime(),
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    'network',
    'connection refused',
  );
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} finally {
  db.close();
}
process.stdout.write(`${JSON.stringify({ ok: true, home })}\n`);
