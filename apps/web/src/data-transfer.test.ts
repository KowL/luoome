import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { money, STANDARD_DISCLAIMERS, stockCode } from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import { exportDataArchive, importDataArchive } from './data-transfer.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const databasePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'luoome-transfer-'));
  dirs.push(dir);
  return join(dir, 'luoome.db');
};

describe('data transfer', () => {
  it('按分类导出并合并导入', async () => {
    const sourcePath = databasePath();
    const source = createDrizzleRepos(sourcePath);
    await source.repos.account.save({
      id: 'account-1',
      name: '主账户',
      kind: 'real',
      currency: 'CNY',
      initialCapital: money(1000),
      createdAt: new Date('2026-08-11T00:00:00Z'),
    });
    source.close();

    const archive = exportDataArchive(sourcePath, ['portfolio']);
    expect(archive.categories).toEqual(['portfolio']);
    expect(archive.tables.accounts).toHaveLength(1);
    expect(archive.tables.chat_sessions).toBeUndefined();

    const targetPath = databasePath();
    const target = createDrizzleRepos(targetPath);
    target.close();
    const result = importDataArchive(targetPath, archive);
    expect(result.imported).toBeGreaterThanOrEqual(1);
    const reopened = createDrizzleRepos(targetPath);
    expect((await reopened.repos.account.findById('account-1'))?.name).toBe('主账户');
    reopened.close();
  });

  it('建议和盯盘运行记录可以原样导出并回导', async () => {
    const sourcePath = databasePath();
    const source = createDrizzleRepos(sourcePath);
    await source.repos.advice.save({
      id: 'advice-1',
      subjectKind: 'stock',
      subjectId: '600519.SH',
      decision: 'watch',
      confidence: 70,
      horizon: 'short',
      reasoning: {
        premise: '等待更多信息',
        evidence: ['成交量稳定'],
        counterEvidence: ['短期波动较大'],
      },
      risks: ['市场风险'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      basedOn: { dataAsOf: new Date('2026-08-11T00:00:00Z') },
      validFrom: new Date('2026-08-11T00:00:00Z'),
      validUntil: new Date('2026-08-14T00:00:00Z'),
      createdAt: new Date('2026-08-11T00:00:00Z'),
    });
    await source.repos.watchRun.save({
      id: 'watch-run-1',
      mode: 'once',
      status: 'succeeded',
      startedAt: new Date('2026-08-11T00:00:00Z'),
      finishedAt: new Date('2026-08-11T00:01:00Z'),
      evaluatedPools: 1,
      evaluatedStocks: 3,
      triggered: 3,
      notified: 2,
      suppressedByCooldown: 1,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
    });
    source.close();

    const archive = exportDataArchive(sourcePath, ['advice-reports', 'watchlists']);
    const targetPath = databasePath();
    const target = createDrizzleRepos(targetPath);
    target.close();

    expect(() => importDataArchive(targetPath, archive)).not.toThrow();
    const reopened = createDrizzleRepos(targetPath);
    expect((await reopened.repos.advice.findById('advice-1'))?.disclaimers).toEqual([
      ...STANDARD_DISCLAIMERS,
    ]);
    expect((await reopened.repos.watchRun.findById('watch-run-1'))?.notified).toBe(2);
    reopened.close();
  });

  it('拒绝未知表且不写入任何行', () => {
    const path = databasePath();
    const handle = createDrizzleRepos(path);
    handle.close();
    expect(() =>
      importDataArchive(path, {
        format: 'luoome-data',
        version: 1,
        exportedAt: new Date().toISOString(),
        categories: ['portfolio'],
        tables: { secrets: [{ token: 'nope' }] },
      }),
    ).toThrow('不允许导入');
  });

  it('领域校验失败时整批回滚，不保留同包中的合法行', async () => {
    const path = databasePath();
    const handle = createDrizzleRepos(path);
    await handle.repos.account.save({
      id: 'preserved',
      name: '保留账户',
      kind: 'real',
      currency: 'CNY',
      initialCapital: money(100),
      createdAt: new Date('2026-08-11T00:00:00Z'),
    });
    handle.close();

    expect(() =>
      importDataArchive(path, {
        format: 'luoome-data',
        version: 1,
        exportedAt: new Date().toISOString(),
        categories: ['portfolio'],
        tables: {
          accounts: [
            {
              id: 'valid-before-invalid',
              name: '本应回滚',
              kind: 'real',
              currency: 'CNY',
              initial_capital: 100,
              created_at: Date.parse('2026-08-11T00:00:00Z'),
            },
            {
              id: 'invalid-mock',
              name: '非法账户',
              kind: 'mock',
              currency: 'CN',
              initial_capital: -1,
              created_at: Date.parse('2026-08-11T00:00:00Z'),
            },
          ],
        },
      }),
    ).toThrow('表 accounts');

    const reopened = createDrizzleRepos(path);
    expect(await reopened.repos.account.findById('preserved')).not.toBeNull();
    expect(await reopened.repos.account.findById('valid-before-invalid')).toBeNull();
    expect(await reopened.repos.account.findById('invalid-mock')).toBeNull();
    reopened.close();
  });

  it('分别拒绝非法账户类型、币种和金额', () => {
    const baseRow = {
      id: 'invalid-account',
      name: '非法账户',
      kind: 'real',
      currency: 'CNY',
      initial_capital: 100,
      created_at: Date.parse('2026-08-11T00:00:00Z'),
    };
    for (const invalidRow of [
      { ...baseRow, kind: 'mock' },
      { ...baseRow, currency: 'CN' },
      { ...baseRow, initial_capital: -1 },
    ]) {
      const path = databasePath();
      const handle = createDrizzleRepos(path);
      handle.close();
      expect(() =>
        importDataArchive(path, {
          format: 'luoome-data',
          version: 1,
          exportedAt: new Date().toISOString(),
          categories: ['portfolio'],
          tables: { accounts: [invalidRow] },
        }),
      ).toThrow('表 accounts');
    }
  });

  it('导出所有表使用同一读事务，避免并发写入产生孤儿关系', async () => {
    const path = databasePath();
    const handle = createDrizzleRepos(path);
    await handle.repos.account.save({
      id: 'account-before-export',
      name: '导出前账户',
      kind: 'real',
      currency: 'CNY',
      initialCapital: money(100),
      createdAt: new Date('2026-08-11T00:00:00Z'),
    });
    await handle.repos.stock.save({
      id: '600519.SH',
      code: stockCode('600519'),
      exchange: 'SH',
      name: '贵州茅台',
    });
    handle.close();

    const originalQuery = Database.prototype.query;
    let injected = false;
    const patchedQuery = function (this: Database, sql: string) {
      const statement = originalQuery.call(this, sql) as ReturnType<Database['query']>;
      if (injected || sql !== 'SELECT * FROM "accounts"') return statement;
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property !== 'all') return Reflect.get(target, property, receiver);
          return () => {
            const rows = target.all();
            injected = true;
            const writer = new Database(path);
            try {
              writer.exec('PRAGMA journal_mode = WAL');
              writer.exec(`
                INSERT INTO accounts (id, name, kind, currency, initial_capital, created_at)
                VALUES ('account-during-export', '并发账户', 'real', 'CNY', 100, 1786406400000);
                INSERT INTO holdings (
                  id, account_id, stock_id, quantity, available_quantity, avg_cost, opened_at, closed_at
                ) VALUES (
                  'holding-during-export', 'account-during-export', '600519.SH', 100, 100, 10, 1786406400000, NULL
                );
              `);
            } finally {
              writer.close();
            }
            return rows;
          };
        },
      });
    } as unknown as typeof Database.prototype.query;
    Database.prototype.query = patchedQuery;

    try {
      const archive = exportDataArchive(path, ['portfolio']);
      const accountIds = new Set(archive.tables.accounts?.map((row) => row.id));
      expect(archive.tables.holdings?.every((row) => accountIds.has(row.account_id))).toBe(true);
      expect(injected).toBe(true);
    } finally {
      Database.prototype.query = originalQuery;
    }
  });
});
