// T48 数据导入验收的合成事实 fixture（Bun + bun:sqlite 建库，随后 DSH Node 进程用 node:sqlite 打开）。
//
// 用法（仅供 infra/dsh/data-import-acceptance.ts 调用）：
//   bun --no-env-file packages/dsh-luoome/src/testing/data-import-fixture.ts schema <dbPath>
//   bun --no-env-file packages/dsh-luoome/src/testing/data-import-fixture.ts seed <dbPath> '<ownerJson>' '<accountName>'
//
// 两份命令都会把库收成「无 WAL 边车」的独立快照：checkpoint(TRUNCATE) + journal_mode=DELETE。
// 数据全部合成，不读真实个人库。
import { Database } from 'bun:sqlite';
import { money } from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';

const [command, dbPath, ownerJson, accountName] = process.argv.slice(2);
if (!command || !dbPath) throw new Error('usage: schema|seed <dbPath> [ownerJson] [accountName]');

const handle = createDrizzleRepos(dbPath);
try {
  if (command === 'seed') {
    if (!ownerJson || !accountName) throw new Error('seed 需要 ownerJson 与 accountName');
    const owner = JSON.parse(ownerJson) as { userId: string; accountId: string };
    const now = new Date('2026-10-01T00:00:00.000Z');
    await handle.repos.account.save({
      id: owner.accountId,
      name: accountName,
      currency: 'CNY',
      initialCapital: money(1000),
      cashBalance: money(1000),
      kind: 'real',
      createdAt: now,
    });
  } else if (command !== 'schema') {
    throw new Error(`未知命令: ${command}`);
  }
} finally {
  handle.close();
}
// 收成独立快照：无 WAL 边车，导入读取端会拒绝非空 WAL。
const raw = new Database(dbPath);
try {
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} finally {
  raw.close();
}
process.stdout.write(`${JSON.stringify({ ok: true, command, dbPath })}\n`);
