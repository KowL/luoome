import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  money,
  reconcileCashBalance,
  STANDARD_DISCLAIMERS,
  stockCode,
  TradingPlanSchema,
} from '@luoome/core';
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

const transferPlan = () =>
  TradingPlanSchema.parse({
    id: 'account:account-1:stock:600519.SH',
    version: 1,
    accountId: 'account-1',
    stockId: '600519.SH',
    stockName: '贵州茅台',
    industry: '白酒',
    status: 'active',
    action: 'enter',
    entryPriceLow: 100,
    entryPriceHigh: 105,
    entryConditions: [],
    invalidEntryConditions: [],
    position: {
      currentPct: 0,
      targetPct: 10,
      deltaPct: 10,
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: [],
    },
    holding: {
      minTradingDays: 1,
      maxTradingDays: 5,
      nextReviewAt: new Date('2026-08-12T00:00:00Z'),
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: { conditions: [], canSellNow: false },
    validFrom: new Date('2026-08-11T00:00:00Z'),
    validUntil: new Date('2026-08-20T00:00:00Z'),
    invalidationConditions: [],
    accountFactsAsOf: new Date('2026-08-11T00:00:00.000Z'),
    accountFactsDigest: 'data-transfer-plan-digest',
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
    confidence: 60,
    createdAt: new Date('2026-08-11T00:00:00Z'),
  });

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
      cashBalance: money(1000),
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

  it('持仓现金调整随账户导出回导，已平仓历史仍可对账', async () => {
    const sourcePath = databasePath();
    const source = createDrizzleRepos(sourcePath);
    const at = new Date('2026-09-15T02:00:00Z');
    const account = {
      id: 'account-1',
      name: '主账户',
      kind: 'real' as const,
      currency: 'CNY',
      initialCapital: money(10000),
      cashBalance: money(10000),
      createdAt: at,
    };
    await source.repos.account.save(account);
    const holding = {
      id: 'holding-1',
      accountId: account.id,
      stockId: '600519.SH',
      quantity: 100,
      availableQuantity: 100,
      avgCost: money(10),
      openedAt: at,
      closedAt: null,
    };
    await source.repos.ledger.applyHolding({ previousHolding: null, holding, occurredAt: at });
    await source.repos.ledger.applyHolding({
      previousHolding: holding,
      holding: { ...holding, closedAt: at },
      occurredAt: at,
    });
    source.close();
    const archive = exportDataArchive(sourcePath, ['portfolio']);
    expect(archive.tables.holding_cash_adjustments).toHaveLength(2);
    const targetPath = databasePath();
    createDrizzleRepos(targetPath).close();
    importDataArchive(targetPath, archive);
    const target = createDrizzleRepos(targetPath);
    try {
      const saved = await target.repos.account.findById(account.id);
      expect(saved).not.toBeNull();
      if (saved === null) throw new Error('imported account missing');
      const result = reconcileCashBalance(saved, {
        account: saved,
        holdings: await target.repos.holding.listByAccount(account.id),
        trades: [],
        cashFlows: [],
        holdingAdjustments: await target.repos.ledger.listHoldingAdjustments(account.id),
      });
      expect(result).toMatchObject({ reconciled: true, difference: 0, gaps: [] });
    } finally {
      target.close();
    }
  });

  it('真实天梯 PIT 快照随 market-data 分类导出并回导', async () => {
    const sourcePath = databasePath();
    const source = createDrizzleRepos(sourcePath);
    await source.repos.limitUpLadderSnapshot.save({
      date: '2026-08-13',
      total: 1,
      maxLevel: 3,
      source: 'eastmoney',
      levels: [
        {
          level: 3,
          name: '3 连板',
          count: 1,
          stocks: [
            {
              code: '600519',
              name: '贵州茅台',
              industry: '白酒',
              ladderLevel: 3,
              uncategorized: false,
              firstTime: '09:31:00',
              finalTime: '14:50:00',
              reason: '真实快照导出夹具',
              price: 100,
              rawClose: 100,
              corrected: false,
              changePct: 0.1,
              limitUpDate: '2026-08-13',
              board: 'main_board',
            },
          ],
        },
      ],
      warnings: [],
      asOf: new Date('2026-08-13T07:00:00Z'),
    });
    source.close();

    const archive = exportDataArchive(sourcePath, ['market-data']);
    expect(archive.tables.limit_up_ladder_snapshots).toHaveLength(1);
    const targetPath = databasePath();
    const target = createDrizzleRepos(targetPath);
    target.close();
    expect(() => importDataArchive(targetPath, archive)).not.toThrow();
    const reopened = createDrizzleRepos(targetPath);
    await expect(
      reopened.repos.limitUpLadderSnapshot.findByDate({
        date: '2026-08-13',
        source: 'eastmoney',
      }),
    ).resolves.toMatchObject({ total: 1, maxLevel: 3 });
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
    await source.repos.advice.recordOutcome('advice-1', {
      adviceId: 'advice-1',
      tradeIds: ['trade-1'],
      outcome: 'partially_followed',
      pnl: money(-12.5),
      benchmarkPnl: money(4),
      holdingHours: 6,
      notes: '只执行一半',
      recordedAt: new Date('2026-08-12T00:00:00Z'),
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
    expect((await reopened.repos.advice.findById('advice-1'))?.outcome).toMatchObject({
      tradeIds: ['trade-1'],
      outcome: 'partially_followed',
      pnl: -12.5,
      benchmarkPnl: 4,
      holdingHours: 6,
      notes: '只执行一半',
    });
    expect((await reopened.repos.watchRun.findById('watch-run-1'))?.notified).toBe(2);
    reopened.close();
  });

  it('Advice SQLite roundtrip 保留交易计划消费的价位区间和目标仓位', async () => {
    const path = databasePath();
    const handle = createDrizzleRepos(path);
    await handle.repos.advice.save({
      id: 'advice-plan-fields',
      subjectKind: 'stock',
      subjectId: '600519.SH',
      decision: 'buy',
      confidence: 80,
      horizon: 'short',
      entryPrice: money(102),
      entryPriceLow: money(100),
      entryPriceHigh: money(105),
      targetPositionPct: 10,
      targetPrice: money(120),
      stopLoss: money(95),
      reasoning: {
        premise: '价位条件满足',
        evidence: ['报价可核对'],
        counterEvidence: ['波动仍需观察'],
      },
      risks: ['市场风险'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      basedOn: { dataAsOf: new Date('2026-08-11T00:00:00Z') },
      validFrom: new Date('2026-08-11T00:00:00Z'),
      validUntil: new Date('2026-08-14T00:00:00Z'),
      createdAt: new Date('2026-08-11T00:00:00Z'),
    });
    const reread = await handle.repos.advice.findById('advice-plan-fields');
    handle.close();
    expect(reread).toMatchObject({
      entryPrice: 102,
      entryPriceLow: 100,
      entryPriceHigh: 105,
      targetPositionPct: 10,
      targetPrice: 120,
      stopLoss: 95,
    });
  });

  it('交易计划备份使用 storage metadata 校验后可以回导', async () => {
    const sourcePath = databasePath();
    const source = createDrizzleRepos(sourcePath);
    await source.repos.tradingPlan.save(transferPlan());
    source.close();

    const archive = exportDataArchive(sourcePath, ['advice-reports']);
    const targetPath = databasePath();
    const target = createDrizzleRepos(targetPath);
    target.close();
    expect(() => importDataArchive(targetPath, archive)).not.toThrow();
  });

  it('拒绝 storage metadata 与 plan_json 不一致的交易计划行', async () => {
    const sourcePath = databasePath();
    const source = createDrizzleRepos(sourcePath);
    await source.repos.tradingPlan.save(transferPlan());
    source.close();

    const archive = exportDataArchive(sourcePath, ['advice-reports']);
    const planRows = archive.tables.trading_plans ?? [];
    const tampered = {
      ...archive,
      tables: {
        ...archive.tables,
        trading_plans: planRows.map((row) => ({ ...row, status: 'draft' })),
      },
    };
    const targetPath = databasePath();
    const target = createDrizzleRepos(targetPath);
    target.close();
    expect(() => importDataArchive(targetPath, tampered)).toThrow(
      'trading_plans status 与 plan_json 元数据不一致',
    );
  });

  it('自治动作审计随 strategies 分类导出并回导', async () => {
    const sourcePath = databasePath();
    const source = createDrizzleRepos(sourcePath);
    const at = new Date('2026-08-30T02:00:00Z');
    await source.repos.strategyAutonomyAction.save({
      id: 'action-export-1',
      kind: 'pause',
      status: 'executed',
      strategyId: 'strategy-export',
      trigger: 'weekly-review',
      ruleSnapshot: {
        sampleCount: 25,
        benchmarkCoverage: 0.95,
        avgExcessReturn: -0.02,
        medianExcessReturn: -0.01,
        thresholds: { minSampleCount: 20 },
      },
      aiNarrative: '超额收益持续为负，按冻结阈值自动暂停',
      factReferences: ['strategy-insight-facts:strategy-export:t5'],
      attempts: 0,
      createdAt: at,
      updatedAt: at,
      completedAt: at,
    });
    source.close();

    const archive = exportDataArchive(sourcePath, ['strategies']);
    expect(archive.tables.strategy_autonomy_actions).toHaveLength(1);
    expect(archive.tables.accounts).toBeUndefined();

    const targetPath = databasePath();
    const target = createDrizzleRepos(targetPath);
    target.close();
    expect(() => importDataArchive(targetPath, archive)).not.toThrow();
    const reopened = createDrizzleRepos(targetPath);
    expect(await reopened.repos.strategyAutonomyAction.findById('action-export-1')).toMatchObject({
      kind: 'pause',
      status: 'executed',
      aiNarrative: '超额收益持续为负，按冻结阈值自动暂停',
      ruleSnapshot: { sampleCount: 25 },
    });
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
      cashBalance: money(100),
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
      cashBalance: money(100),
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
