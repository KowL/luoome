import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Account,
  AccountSnapshotSchema,
  money,
  type Stock,
  stockCode,
  type TradingPlan,
  TradingPlanSchema,
} from '@luoome/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createDrizzleRepos } from '../../client.js';

const NOW = new Date('2026-09-09T02:00:00.000Z');
const ACCOUNT_ID = 'budget-concurrency-account';

const account: Account = {
  id: ACCOUNT_ID,
  name: '预算并发测试账户',
  kind: 'real',
  currency: 'CNY',
  initialCapital: money(100_000),
  cashBalance: money(100_000),
  createdAt: NOW,
};

const stocks: readonly Stock[] = [
  {
    id: '000001.SZ',
    code: stockCode('000001'),
    exchange: 'SZ',
    name: '基准持仓',
    industry: '电力',
  },
  {
    id: '600036.SH',
    code: stockCode('600036'),
    exchange: 'SH',
    name: '招商银行',
    industry: '银行',
  },
  {
    id: '600519.SH',
    code: stockCode('600519'),
    exchange: 'SH',
    name: '贵州茅台',
    industry: '银行',
  },
];

const snapshot = AccountSnapshotSchema.parse({
  id: 'budget-concurrency-snapshot',
  accountId: ACCOUNT_ID,
  version: 1,
  asOf: NOW,
  cashBalance: 40_000,
  stockMarketValue: 60_000,
  totalAssets: 100_000,
  status: 'complete',
  positions: [
    {
      stockId: '000001.SZ',
      quantity: 1000,
      availableQuantity: 1000,
      marketValue: 60_000,
      industry: '电力',
    },
  ],
  source: 'manual',
  createdAt: NOW,
});

const makePlan = (stockId: string): TradingPlan =>
  TradingPlanSchema.parse({
    id: `account:${ACCOUNT_ID}:stock:${stockId}`,
    version: 1,
    accountId: ACCOUNT_ID,
    stockId,
    stockName: stockId,
    industry: '银行',
    status: 'active',
    action: 'enter',
    entryPriceLow: 10,
    entryPriceHigh: 11,
    entryConditions: [],
    invalidEntryConditions: [],
    position: {
      currentPct: 0,
      targetPct: 15,
      deltaPct: 15,
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: ['用户手动执行后更新账户快照'],
    },
    holding: {
      minTradingDays: 1,
      maxTradingDays: 5,
      nextReviewAt: new Date('2026-09-12T00:00:00.000Z'),
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: { conditions: [], triggerConditions: [], canSellNow: false },
    validFrom: new Date('2026-09-08T00:00:00.000Z'),
    validUntil: new Date('2026-09-30T00:00:00.000Z'),
    invalidationConditions: ['账户快照版本改变'],
    accountSnapshotId: snapshot.id,
    accountSnapshotVersion: snapshot.version,
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
    confidence: 60,
    createdAt: NOW,
  });

const childScript = (clientPath: string): string => `
import { createDrizzleRepos } from ${JSON.stringify(clientPath)};
import { AccountSnapshotSchema, TradingPlanSchema, money, stockCode } from '@luoome/core';
const now = new Date(${JSON.stringify(NOW.toISOString())});
const snapshot = AccountSnapshotSchema.parse(JSON.parse(process.env.PR30_SNAPSHOT_JSON));
const plan = TradingPlanSchema.parse(JSON.parse(process.env.PR30_PLAN_JSON));
const stocks = new Map([
  ['000001.SZ', { id: '000001.SZ', code: stockCode('000001'), exchange: 'SZ', name: '基准持仓', industry: '电力' }],
  ['600036.SH', { id: '600036.SH', code: stockCode('600036'), exchange: 'SH', name: '招商银行', industry: '银行' }],
  ['600519.SH', { id: '600519.SH', code: stockCode('600519'), exchange: 'SH', name: '贵州茅台', industry: '银行' }],
]);
const handle = createDrizzleRepos(process.env.PR30_DB_PATH);
try {
  const result = await handle.repos.tradingPlan.saveIfBudgetAvailable({
    plan,
    snapshot,
    stocks,
    limits: { totalStockPct: 80, singleStockPct: 15, industryPct: 30 },
    asOf: now,
  });
  console.log(JSON.stringify({ saved: result.saved, status: result.budget.totalStatus }));
} finally {
  handle.close();
}
`;

const childResult = async (
  dbPath: string,
  plan: TradingPlan,
  clientPath: string,
): Promise<{ readonly saved: boolean; readonly status: string }> => {
  const child = Bun.spawn([process.execPath, '-e', childScript(clientPath)], {
    cwd: new URL('../../../', import.meta.url).pathname,
    env: {
      ...process.env,
      PR30_DB_PATH: dbPath,
      PR30_PLAN_JSON: JSON.stringify(plan),
      PR30_SNAPSHOT_JSON: JSON.stringify(snapshot),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`budget child failed (${exitCode}): ${stdout}\n${stderr}`);
  }
  const line = stdout.trim().split('\n').at(-1);
  if (line === undefined) throw new Error('budget child returned no result');
  return JSON.parse(line) as { saved: boolean; status: string };
};

describe('Drizzle trading plan budget transaction', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it('两个独立 Bun 进程并发激活时至多一个突破剩余总仓位预算', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'luoome-plan-budget-concurrency-'));
    directories.push(directory);
    const dbPath = join(directory, 'budget.sqlite');
    const handle = createDrizzleRepos(dbPath);
    await handle.repos.account.save(account);
    for (const stock of stocks) await handle.repos.stock.save(stock);
    await handle.repos.accountSnapshot.save(snapshot);
    const clientPath = new URL('../../client.ts', import.meta.url).pathname;
    handle.close();

    const results = await Promise.all([
      childResult(dbPath, makePlan('600036.SH'), clientPath),
      childResult(dbPath, makePlan('600519.SH'), clientPath),
    ]);
    expect(results.filter((result) => result.saved)).toHaveLength(1);
    expect(results.filter((result) => !result.saved)).toHaveLength(1);

    const check = createDrizzleRepos(dbPath);
    try {
      expect(
        await check.repos.tradingPlan.list({ accountId: ACCOUNT_ID, activeOnly: true, asOf: NOW }),
      ).toHaveLength(1);
    } finally {
      check.close();
    }
  });
});
