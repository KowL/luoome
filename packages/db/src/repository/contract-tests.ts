import {
  type Account,
  type Advice,
  type AdviceOutcome,
  type AlertPlan,
  buildAccountFacts,
  type ChatMessage,
  type ChatSession,
  CURRENT_STRATEGY_EVALUATOR_IDENTITY,
  type DailyBar,
  type DailyBarRevision,
  type Holding,
  InvariantError,
  type LimitUpLadder,
  type MarketSnapshotBatch,
  type MinuteBar,
  money,
  type Notification,
  type PortfolioCashFlow,
  type PortfolioCorporateAction,
  type PortfolioPerformanceSnapshot,
  type Quote,
  quantity,
  type Report,
  type RepositoryRegistry,
  type ResearchDocumentIndex,
  reconcileCashBalance,
  type SectorCatalogObservation,
  type SectorKind,
  type SectorSyncApplyInput,
  type SignalObservation,
  STANDARD_DISCLAIMERS,
  type Stock,
  type StockUniverseEntry,
  type Strategy,
  type StrategyResult,
  type StrategyRun,
  type StrategySignal,
  type StrategyVersion,
  type StrategyWatchlistSubscription,
  type StrictBacktestGateAudit,
  type StrictBacktestRun,
  type StrictBacktestSpec,
  stockCode,
  strategyDefinitionHash,
  strictBacktestHash,
  strictBacktestSpecHash,
  type Trade,
  type TradingPlan,
  type Watchlist,
  type WatchlistMemberSource,
  type WatchlistSyncRun,
  type WatchTrigger,
  type WorkflowRun,
} from '@luoome/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * 仓储契约测试套件：Drizzle 实现与 in-memory 实现必须满足同一组行为。
 * 每个测试前通过 factory 拿到全新空库，测试后 close。
 */
export interface ContractHandle {
  readonly repos: RepositoryRegistry;
  /** 读取已回填的 outcome（具体类的扩展方法，供 recordOutcome 断言）。 */
  readonly readOutcome: (adviceId: string) => Promise<AdviceOutcome | null>;
  readonly close?: () => void;
}

// ---------- fixtures ----------

const T0 = new Date('2026-07-01T01:00:00.000Z');
const T1 = new Date('2026-07-02T01:00:00.000Z');
const T2 = new Date('2026-07-03T01:00:00.000Z');
const T3 = new Date('2026-07-04T01:00:00.000Z');
const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');
const FAR_PAST = new Date('2000-01-01T00:00:00.000Z');

const makeLimitUpLadder = (overrides: Partial<LimitUpLadder> = {}): LimitUpLadder => ({
  date: '2026-07-01',
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
          finalTime: '09:31:00',
          reason: '测试事实',
          price: 100,
          rawClose: 100,
          corrected: false,
          changePct: 0.1,
          limitUpDate: '2026-07-01',
          board: 'main_board',
        },
      ],
    },
  ],
  warnings: [],
  asOf: T1,
  ...overrides,
});

const makeMarketSnapshotBatch = (
  overrides: Partial<MarketSnapshotBatch> = {},
): MarketSnapshotBatch => ({
  id: 'CN_A_SHARES_SH_SZ|2026-09-28T02:15:00.000Z',
  coverage: 'CN_A_SHARES_SH_SZ',
  tradingDate: '2026-09-28',
  sampledAt: new Date('2026-09-28T02:15:00.000Z'),
  source: 'eastmoney',
  fetchedAt: new Date('2026-09-28T02:16:02.000Z'),
  observedAt: new Date('2026-09-28T02:16:00.000Z'),
  dataAsOf: new Date('2026-09-28T02:16:00.000Z'),
  completeness: {
    expectedCount: 2,
    receivedCount: 2,
    missingCount: 0,
    duplicateCount: 0,
    complete: true,
  },
  gaps: [],
  items: [
    {
      id: '600519.SH',
      code: '600519',
      exchange: 'SH',
      name: '贵州茅台',
      close: 1500,
      changePct: 1.2,
      amount: 3_000_000_000,
    },
    {
      id: '000001.SZ',
      code: '000001',
      exchange: 'SZ',
      name: '平安银行',
      close: 11.2,
      changePct: -0.4,
      amount: 1_200_000_000,
    },
  ],
  ...overrides,
});

const makeAlertPlan = (id: string, overrides: Partial<AlertPlan> = {}): AlertPlan => ({
  id,
  name: `提醒-${id}`,
  watchlistId: 'watchlist-1',
  rules: [{ id: 'price', kind: 'price-change', pct: 0.05, direction: 'any' }],
  logic: 'ANY',
  triggerMode: 'on-enter',
  cooldownMinutes: 30,
  dailyNotificationLimit: 20,
  notifyOnRecovery: false,
  enabled: true,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

export const makeAccount = (id: string, overrides: Partial<Account> = {}): Account => ({
  id,
  name: `账户-${id}`,
  kind: 'real',
  currency: 'CNY',
  initialCapital: money(1_000_000),
  cashBalance: money(1_000_000),
  createdAt: T0,
  ...overrides,
});

export const makeTradingPlan = (
  id: string,
  version: number,
  overrides: Partial<TradingPlan> = {},
): TradingPlan => ({
  id,
  version,
  accountId: 'acc-1',
  stockId: 'stk-1',
  industry: '制造业',
  status: 'active',
  action: 'hold',
  entryConditions: [],
  invalidEntryConditions: [],
  position: {
    currentPct: 0,
    targetPct: 0,
    deltaPct: 0,
    constraintStatus: 'passed',
    constraintReasons: [],
    prerequisiteActions: [],
  },
  holding: {
    minTradingDays: 1,
    maxTradingDays: 5,
    nextReviewAt: T2,
    earlyExitConditions: [],
    extensionBasis: [],
  },
  exit: { conditions: [], triggerConditions: [], canSellNow: true },
  validFrom: T1,
  validUntil: T3,
  invalidationConditions: [],
  accountFactsAsOf: T0,
  accountFactsDigest: 'account-facts-contract-digest',
  marketFacts: [],
  evidence: [],
  source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
  explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
  confidence: 50,
  createdAt: T1,
  ...overrides,
});

const makeChatSession = (id: string, overrides: Partial<ChatSession> = {}): ChatSession => ({
  id,
  accountId: 'account-1',
  title: `会话-${id}`,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

const makeChatMessage = (
  id: string,
  sessionId: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage => ({
  id,
  sessionId,
  role: 'user',
  parts: [{ type: 'text', text: `消息-${id}` }],
  createdAt: T0,
  ...overrides,
});

export const makeStock = (id: string, code: string, overrides: Partial<Stock> = {}): Stock => ({
  id,
  code: stockCode(code),
  exchange: 'SZ',
  name: `股票-${code}`,
  industry: '制造业',
  ...overrides,
});

export const makeHolding = (id: string, overrides: Partial<Holding> = {}): Holding => ({
  id,
  accountId: 'acc-1',
  stockId: 'stk-1',
  quantity: 1000,
  availableQuantity: 800,
  avgCost: money(12.3456),
  openedAt: T0,
  closedAt: null,
  ...overrides,
});

export const makeTrade = (id: string, overrides: Partial<Trade> = {}): Trade => ({
  id,
  accountId: 'acc-1',
  stockId: 'stk-1',
  side: 'buy',
  quantity: quantity(1000),
  price: money(14.5),
  fee: money(5),
  executedAt: T1,
  source: 'manual',
  createdAt: T1,
  ...overrides,
});

export const makeQuote = (stockId: string, ts: Date, overrides: Partial<Quote> = {}): Quote => ({
  stockId,
  observedAt: ts,
  fetchedAt: ts,
  timestampSource: 'retrieval',
  ts,
  open: money(10),
  high: money(11),
  low: money(9),
  close: money(10.5),
  volume: 1_000_000,
  source: 'test',
  ...overrides,
});

export const makeDailyBar = (
  stockId: string,
  date: Date,
  overrides: Partial<DailyBar> = {},
): DailyBar => ({
  stockId,
  date,
  open: money(10),
  high: money(11),
  low: money(9),
  close: money(10.5),
  volume: 1_000_000,
  adjustment: 'qfq',
  source: 'test',
  ...overrides,
});

export const makeMinuteBar = (
  stockId: string,
  endedAt: Date,
  overrides: Partial<MinuteBar> = {},
): MinuteBar => ({
  stockId,
  interval: '1m',
  endedAt,
  open: money(10),
  high: money(11),
  low: money(9),
  close: money(10.5),
  volume: 10_000,
  adjustment: 'raw',
  source: 'tushare',
  fetchedAt: new Date(endedAt.getTime() + 1_000),
  completeness: 'closed',
  ...overrides,
});

export const makeAdvice = (id: string, overrides: Partial<Advice> = {}): Advice => ({
  id,
  subjectKind: 'stock',
  subjectId: 'stk-1',
  decision: 'hold',
  confidence: 65,
  horizon: 'short',
  reasoning: {
    premise: '短期处于箱体震荡，等待方向选择',
    evidence: ['日线 MA5/MA10/MA20 粘合'],
    counterEvidence: ['板块整体回暖'],
  },
  risks: ['大盘系统性下行风险'],
  disclaimers: [...STANDARD_DISCLAIMERS],
  sourceTool: 'analyze_stock',
  basedOn: { dataAsOf: T1 },
  validFrom: T1,
  validUntil: FAR_FUTURE,
  createdAt: T1,
  ...overrides,
});

export const makeStrategy = (id: string, overrides: Partial<Strategy> = {}): Strategy => ({
  id,
  name: `策略-${id}`,
  description: 'fixture strategy',
  owner: 'user',
  status: 'draft',
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

export const makeStrategyVersion = (
  strategyId: string,
  version = 1,
  overrides: Partial<StrategyVersion> = {},
): StrategyVersion => {
  const definition: StrategyVersion['definition'] = {
    schemaVersion: 1,
    metadata: { style: 'momentum' },
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: {
      logic: 'all',
      rules: [{ id: 'rule-1', name: 'Rule', when: 'true', evidence: ['matched'] }],
    },
    signals: { entry: [], exit: [], risk: [] },
  };
  return {
    id: `${strategyId}-v${version}`,
    strategyId,
    version,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: T1,
    createdAt: T0,
    ...overrides,
  };
};

const makeSignalObservation = (
  id: string,
  sourceId: string,
  overrides: Partial<SignalObservation> = {},
): SignalObservation => ({
  id,
  sourceKind: 'strategy-signal',
  sourceId,
  stockId: '600519.SH',
  baselinePrice: 10,
  baselineAt: T1,
  horizon: 't1',
  benchmarkStatus: 'unavailable',
  status: 'pending',
  provenance: {
    provider: 'fixture',
    observedAt: T1,
    fetchedAt: T1,
    freshness: 'fresh',
  },
  ...overrides,
});

export const makeStrategyRun = (id: string, overrides: Partial<StrategyRun> = {}): StrategyRun => {
  const run = {
    id,
    strategyId: 'strategy-1',
    strategyVersionId: 'strategy-1-v1',
    mode: 'scan' as const,
    coverage: 'CN_A_SHARES_SH_SZ' as const,
    dataAsOf: T1,
    startedAt: T1,
    finishedAt: T2,
    status: 'complete' as const,
    scope: 'operational' as const,
    inputSnapshot: { fixture: true },
    providerStatuses: [],
    summary: { selected: 1 },
    ...overrides,
  };
  const { finishedAt, summary, error, ...withoutOptionalUndefined } = run;
  return {
    ...withoutOptionalUndefined,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(summary === undefined ? {} : { summary }),
    ...(error === undefined ? {} : { error }),
    ...(run.status === 'complete' && run.publication === undefined
      ? {
          publication: {
            status: 'published' as const,
            reasons: ['legacy-publication' as const],
            decidedAt: finishedAt ?? run.startedAt,
          },
        }
      : {}),
  };
};

const makeStrategyResult = (
  runId: string,
  stockId: string,
  overrides: Partial<StrategyResult> = {},
): StrategyResult => ({
  runId,
  stockId,
  selected: true,
  score: 80,
  rank: 1,
  ruleEvaluations: [{ ruleId: 'rule-1', status: 'matched', value: true, evidence: ['matched'] }],
  evidence: ['matched'],
  dataAsOf: T1,
  ...overrides,
});

const makeStrategySignal = (
  id: string,
  stockId: string,
  overrides: Partial<StrategySignal> = {},
): StrategySignal => ({
  id,
  strategyId: 'strategy-1',
  strategyVersionId: 'strategy-1-v1',
  runId: 'run-1',
  ruleId: 'signal-1',
  stockId,
  ts: T2,
  score: 80,
  direction: 'bullish',
  evidence: ['matched'],
  evaluationSnapshot: { matched: true },
  ...overrides,
});

const makeWatchlist = (id: string, overrides: Partial<Watchlist> = {}): Watchlist => ({
  id,
  name: `观察-${id}`,
  kind: 'strategy',
  membershipPolicy: 'synced',
  enabled: true,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

const makeWatchlistSyncRun = (
  id: string,
  overrides: Partial<WatchlistSyncRun> = {},
): WatchlistSyncRun => ({
  id,
  watchlistId: 'watchlist-1',
  sourceKind: 'strategy',
  sourceKey: 'strategy:strategy-1',
  status: 'complete',
  dataAsOf: T1,
  startedAt: T1,
  finishedAt: T2,
  enteredCount: 0,
  exitedCount: 0,
  unchangedCount: 0,
  missingDimensions: [],
  ...overrides,
});

const makeStrategyWatchlistSubscription = (
  id: string,
  overrides: Partial<StrategyWatchlistSubscription> = {},
): StrategyWatchlistSubscription => ({
  id,
  strategyId: 'strategy-1',
  watchlistId: 'watchlist-1',
  sourceKey: 'strategy:strategy-1',
  status: 'active',
  createdBy: 'user-1',
  createdAt: T1,
  updatedAt: T1,
  ...overrides,
});

export const makeNotification = (
  id: string,
  overrides: Partial<Notification> = {},
): Notification => ({
  id,
  channel: 'log',
  payload: { title: 'fixture title', content: 'fixture content', level: 'info' },
  result: 'success',
  sentAt: T1,
  ...overrides,
});

export const makeWatchTrigger = (
  id: string,
  overrides: Partial<WatchTrigger> = {},
): WatchTrigger => ({
  id,
  alertPlanId: 'pool-1',
  poolId: 'pool-1',
  stockId: '002594.SZ',
  ruleKind: 'price-change',
  ruleId: 'r_fixture',
  triggerType: 'triggered',
  direction: 'watch',
  priority: 'normal',
  deliveryStatus: 'sent',
  evalSnapshot: { ruleId: 'r_fixture' },
  reason: 'fixture reason',
  evidence: ['close=15.2'],
  quote: { close: money(15.2), ts: T1 },
  notified: true,
  createdAt: T1,
  ...overrides,
});

const makeResearchDocument = (
  id: string,
  overrides: Partial<ResearchDocumentIndex> = {},
): ResearchDocumentIndex => ({
  id: `doc_${id}`,
  title: id,
  kind: 'report',
  importedAt: T1,
  tags: [],
  stockCodes: [],
  vaultId: 'vault-test',
  relativePath: `Research/${id}.md`,
  attachmentPaths: [],
  contentHash: 'b'.repeat(64),
  fileModifiedAt: T1,
  indexedAt: T1,
  availability: 'available',
  ...overrides,
});

export const makeWorkflowRun = (id: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  workflowName: 'post-market-data',
  mode: 'scheduled',
  status: 'succeeded',
  startedAt: T1,
  finishedAt: T2,
  providerStatuses: [],
  ...overrides,
});

export const makeReport = (id: string, overrides: Partial<Report> = {}): Report => ({
  id,
  kind: 'closing',
  scope: { kind: 'all-accounts' },
  periodStart: '2026-07-02',
  periodEnd: '2026-07-02',
  title: `收盘复盘-${id}`,
  generatedAt: T2,
  dataAsOf: T1,
  status: 'complete',
  sections: [
    {
      key: 'market-pulse',
      title: '市场脉搏',
      required: true,
      status: 'complete',
      dataAsOf: T1,
      blocks: [{ kind: 'text', text: '市场平稳', tone: 'factual' }],
      evidenceIds: ['market'],
      missingDimensions: [],
    },
  ],
  evidence: [
    {
      id: 'market',
      dimension: 'market.index',
      provenance: {
        provider: 'fixture',
        observedAt: T1,
        fetchedAt: T2,
        freshness: 'fresh',
      },
    },
  ],
  missingDimensions: [],
  deliveryStatus: 'not-requested',
  workflowRunId: 'workflow-run-1',
  createdAt: T2,
  updatedAt: T2,
  ...overrides,
});

// ---------- 契约套件 ----------

export const registerRepositoryContractTests = (
  label: string,
  factory: () => ContractHandle,
): void => {
  describe(`repository contract [${label}]`, () => {
    let handle: ContractHandle;
    let repos: RepositoryRegistry;

    beforeEach(() => {
      handle = factory();
      repos = handle.repos;
    });

    afterEach(() => {
      handle.close?.();
    });

    describe('AccountRepository', () => {
      it('save + findById 往返一致', async () => {
        const account = makeAccount('acc-1');
        await repos.account.save(account);
        expect(await repos.account.findById('acc-1')).toEqual(account);
        expect(await repos.account.findById('missing')).toBeNull();
      });

      it('list 返回全部账户（按 id 升序）', async () => {
        await repos.account.save(makeAccount('acc-b'));
        await repos.account.save(makeAccount('acc-a'));
        const all = await repos.account.list();
        expect(all.map((a) => a.id)).toEqual(['acc-a', 'acc-b']);
      });

      it('save 同 id 为 upsert', async () => {
        await repos.account.save(makeAccount('acc-1', { name: '旧名' }));
        await repos.account.save(makeAccount('acc-1', { name: '新名' }));
        expect((await repos.account.findById('acc-1'))?.name).toBe('新名');
        expect(await repos.account.list()).toHaveLength(1);
      });

      it('remove 删除后 findById 返回 null', async () => {
        await repos.account.save(makeAccount('acc-1'));
        await repos.account.remove('acc-1');
        expect(await repos.account.findById('acc-1')).toBeNull();
      });

      it('违反不变量时拒绝（initialCapital < 0）', async () => {
        const bad = makeAccount('acc-bad', { initialCapital: money(-1) });
        await expect(repos.account.save(bad)).rejects.toThrow(InvariantError);
      });
    });

    describe('TradingPlanRepository', () => {
      it('最新修订为草案时，原生效计划仍占用预算', async () => {
        const account = makeAccount('budget-draft-account');
        await repos.account.save(account);
        const facts = buildAccountFacts({ account, holdings: [], asOf: T2 });
        const position = {
          currentPct: 0,
          targetPct: 15,
          deltaPct: 15,
          constraintStatus: 'passed' as const,
          constraintReasons: [],
          prerequisiteActions: [],
        };
        const active = makeTradingPlan('budget-draft-1', 1, {
          accountId: account.id,
          accountFactsDigest: facts.digest,
          position,
        });
        await repos.tradingPlan.save(active);
        await repos.tradingPlan.save({ ...active, version: 2, status: 'draft', createdAt: T2 });
        const next = makeTradingPlan('budget-draft-2', 1, {
          accountId: account.id,
          accountFactsDigest: facts.digest,
          stockId: 'stk-2',
          position: { ...position, targetPct: 10, deltaPct: 10 },
        });
        const saved = await repos.tradingPlan.saveIfBudgetAvailable({
          plan: next,
          facts,
          stocks: new Map(),
          limits: { totalStockPct: 20, singleStockPct: 30 },
          asOf: T2,
        });
        expect(saved).toMatchObject({ saved: false, reason: 'budget-exceeded' });
        expect(await repos.tradingPlan.findByVersionId('budget-draft-2:v1')).toBeNull();
      });

      it('当前列表先按计划聚合再应用 limit，保留旧生效版和最新修订', async () => {
        await repos.tradingPlan.save(makeTradingPlan('many-versions', 1));
        for (let version = 2; version <= 12; version++) {
          await repos.tradingPlan.save(
            makeTradingPlan('many-versions', version, { status: 'draft', createdAt: T2 }),
          );
        }
        await repos.tradingPlan.save(makeTradingPlan('another-stock', 1, { stockId: 'stk-2' }));
        const plans = await repos.tradingPlan.list({ currentOnly: true, limit: 2 });
        expect(plans.map((plan) => `${plan.id}:v${plan.version}`)).toEqual([
          'many-versions:v12',
          'many-versions:v1',
          'another-stock:v1',
        ]);
        expect(await repos.tradingPlan.list({ currentOnly: true, limit: 1 })).toHaveLength(2);
      });

      it('按报告截止时间聚合当前版本，之后的撤销不能遮住当时版本', async () => {
        const active = makeTradingPlan('report-cutoff', 1, { createdAt: T1 });
        await repos.tradingPlan.save(active);
        await repos.tradingPlan.save({ ...active, version: 2, status: 'revoked', createdAt: T3 });
        expect(await repos.tradingPlan.list({ currentOnly: true, createdUntil: T2 })).toEqual([
          active,
        ]);
        expect(await repos.tradingPlan.list({ currentOnly: true })).toMatchObject([
          { version: 2, status: 'revoked' },
        ]);
      });

      it('预算提交时复核账户事实，拒绝生成后发生的现金或持仓变化', async () => {
        const account = makeAccount('budget-account');
        const stock = makeStock('stk-1', '002594');
        await repos.account.save(account);
        await repos.stock.save(stock);
        const facts = buildAccountFacts({ account, holdings: [], asOf: T2 });
        const input = {
          facts,
          stocks: new Map([[stock.id, stock]]),
          limits: { totalStockPct: 100, singleStockPct: 30 },
          asOf: T2,
        };
        const first = makeTradingPlan('budget-1', 1, {
          accountId: account.id,
          accountFactsDigest: facts.digest,
        });
        expect(
          await repos.tradingPlan.saveIfBudgetAvailable({ ...input, plan: first }),
        ).toMatchObject({
          saved: true,
        });

        await repos.account.save({ ...account, cashBalance: money(900_000) });
        const second = makeTradingPlan('budget-2', 1, {
          accountId: account.id,
          accountFactsDigest: facts.digest,
        });
        expect(await repos.tradingPlan.saveIfBudgetAvailable({ ...input, plan: second })).toEqual({
          saved: false,
          reason: 'account-facts-changed',
        });
        expect(await repos.tradingPlan.findByVersionId('budget-2:v1')).toBeNull();

        await repos.account.save(account);
        await repos.holding.save(
          makeHolding('budget-holding', {
            accountId: account.id,
            quantity: 100,
            availableQuantity: 100,
          }),
        );
        expect(await repos.tradingPlan.saveIfBudgetAvailable({ ...input, plan: second })).toEqual({
          saved: false,
          reason: 'account-facts-changed',
        });
        expect(await repos.tradingPlan.findByVersionId('budget-2:v1')).toBeNull();
      });

      it('已平仓持仓不参与账户事实指纹，不影响激活保存', async () => {
        const account = makeAccount('budget-closed-account');
        const stock = makeStock('stk-1', '002594');
        await repos.account.save(account);
        await repos.stock.save(stock);
        const activeHolding = makeHolding('active-holding', { accountId: account.id });
        await repos.holding.save(activeHolding);
        await repos.holding.save(
          makeHolding('closed-holding', {
            accountId: account.id,
            stockId: 'stk-closed',
            quantity: 0,
            availableQuantity: 0,
            closedAt: T1,
          }),
        );
        // 与 deriveAccountFacts 同口径：指纹只含当前持仓（未平仓且数量大于 0）
        const facts = buildAccountFacts({
          account,
          holdings: [activeHolding],
          prices: new Map([[activeHolding.stockId, { close: money(10), observedAt: T1 }]]),
          asOf: T2,
        });
        const plan = makeTradingPlan('budget-closed-plan', 1, {
          accountId: account.id,
          accountFactsDigest: facts.digest,
        });
        expect(
          await repos.tradingPlan.saveIfBudgetAvailable({
            facts,
            stocks: new Map([[stock.id, stock]]),
            limits: { totalStockPct: 100, singleStockPct: 30 },
            asOf: T2,
            plan,
          }),
        ).toMatchObject({ saved: true });
      });

      it('版本身份不可变，重复保存同一版本幂等', async () => {
        const plan = makeTradingPlan('plan-1', 1);
        await repos.tradingPlan.save(plan);
        await repos.tradingPlan.save(plan);
        expect(await repos.tradingPlan.findByVersionId('plan-1:v1')).toEqual(plan);
        await expect(repos.tradingPlan.save({ ...plan, confidence: 51 })).rejects.toThrow(
          'immutable',
        );
      });

      it('activeOnly：更新的草案回退到上一个生效版本，退役状态则停止监控', async () => {
        // 生效版本 + 一个更新的草案（非交易日复核只能落草案）→ 仍监控生效版本。
        await repos.tradingPlan.save(makeTradingPlan('plan-1', 1));
        await repos.tradingPlan.save(
          makeTradingPlan('plan-1', 2, { status: 'draft', createdAt: T2 }),
        );
        expect(await repos.tradingPlan.list({ activeOnly: true })).toEqual([
          makeTradingPlan('plan-1', 1),
        ]);

        // 更新的 superseded / revoked / expired 明确退役该计划 → 不再返回。
        await repos.tradingPlan.save(
          makeTradingPlan('plan-1', 3, { status: 'revoked', createdAt: T3 }),
        );
        expect(await repos.tradingPlan.list({ activeOnly: true })).toEqual([]);
      });

      it('activeOnly 只返回每个计划的最新 active 版本', async () => {
        await repos.tradingPlan.save(makeTradingPlan('plan-1', 1));
        await repos.tradingPlan.save(
          makeTradingPlan('plan-1', 2, {
            status: 'superseded',
            supersedesVersionId: 'plan-1:v1',
            createdAt: T2,
          }),
        );
        await repos.tradingPlan.save(makeTradingPlan('plan-2', 1));
        expect(await repos.tradingPlan.list({ activeOnly: true })).toEqual([
          makeTradingPlan('plan-2', 1),
        ]);
        expect(await repos.tradingPlan.latestByPlanId('plan-1')).toMatchObject({ version: 2 });
      });

      it('计划版本创建时间先于 limit 过滤，旧日复盘不被较新版本挤出', async () => {
        const old = makeTradingPlan('plan-old', 1, { createdAt: T1 });
        const target = makeTradingPlan('plan-target', 1, { createdAt: T2 });
        const newer = makeTradingPlan('plan-newer', 1, { createdAt: T3 });
        await repos.tradingPlan.save(old);
        await repos.tradingPlan.save(target);
        await repos.tradingPlan.save(newer);

        expect(
          await repos.tradingPlan.list({ createdSince: T2, createdUntil: T2, limit: 1 }),
        ).toEqual([target]);
        expect(await repos.tradingPlan.list({ createdSince: T3, limit: 1 })).toEqual([newer]);
        expect(await repos.tradingPlan.list({ createdUntil: T1, limit: 1 })).toEqual([old]);
      });
    });

    describe('StockRepository', () => {
      it('save + findById / findByCode 往返一致', async () => {
        const stock = makeStock('stk-1', '002594', { name: '比亚迪' });
        await repos.stock.save(stock);
        expect(await repos.stock.findById('stk-1')).toEqual(stock);
        expect(await repos.stock.findByCode('002594')).toEqual(stock);
        expect(await repos.stock.findByCode('999999')).toBeNull();
      });

      it('industry 可选字段往返', async () => {
        const noIndustry = makeStock('stk-2', '600519');
        const { industry: _drop, ...withoutIndustry } = noIndustry;
        await repos.stock.save(withoutIndustry);
        const got = await repos.stock.findById('stk-2');
        expect(got).toEqual(withoutIndustry);
        expect(got?.industry).toBeUndefined();
      });

      it('search 按代码 / 名称模糊匹配，大小写不敏感', async () => {
        await repos.stock.save(makeStock('stk-1', '002594', { name: '比亚迪' }));
        await repos.stock.save(makeStock('stk-2', 'AAPL', { name: 'Apple', exchange: 'US' }));
        await repos.stock.save(makeStock('stk-3', '600519', { name: '贵州茅台', exchange: 'SH' }));
        expect((await repos.stock.search('0025')).map((s) => s.id)).toEqual(['stk-1']);
        expect((await repos.stock.search('比亚')).map((s) => s.id)).toEqual(['stk-1']);
        expect((await repos.stock.search('aap')).map((s) => s.id)).toEqual(['stk-2']);
        expect((await repos.stock.search('茅台')).map((s) => s.id)).toEqual(['stk-3']);
        expect(await repos.stock.search('不存在的')).toEqual([]);
        // 空 / 纯空白 query → 返回全部（按 id 升序）：run_tactic(scope='all-stocks') /
        // market_outlook / resolve_llm_group 依赖此语义做全市场扫描
        expect((await repos.stock.search('   ')).map((s) => s.id)).toEqual([
          'stk-1',
          'stk-2',
          'stk-3',
        ]);
      });

      it('save 同 id 为 upsert；remove 生效', async () => {
        await repos.stock.save(makeStock('stk-1', '002594', { name: '旧' }));
        await repos.stock.save(makeStock('stk-1', '002594', { name: '新' }));
        expect((await repos.stock.findById('stk-1'))?.name).toBe('新');
        await repos.stock.remove('stk-1');
        expect(await repos.stock.findById('stk-1')).toBeNull();
      });

      it('违反不变量时拒绝（name 为空）', async () => {
        const bad = makeStock('stk-bad', '002594', { name: '' });
        await expect(repos.stock.save(bad)).rejects.toThrow(InvariantError);
      });
    });

    describe('StockUniverseRepository', () => {
      it('完整快照提交后创建规范 Stock，并可读取当前目录', async () => {
        const observedAt = new Date('2026-07-28T08:20:00.000Z');
        const summary = await repos.stockUniverse.applySnapshot({
          syncId: 'sync-1',
          appliedAt: new Date('2026-07-28T08:21:00.000Z'),
          snapshot: {
            source: 'eastmoney',
            coverage: 'CN_A_SHARES_SH_SZ',
            observedAt,
            complete: true,
            reportedTotal: 2,
            entries: [
              {
                stockId: '600519.SH',
                code: stockCode('600519'),
                exchange: 'SH',
                name: '贵州茅台',
                listingStatus: 'listed',
              },
              {
                stockId: '002594.SZ',
                code: stockCode('002594'),
                exchange: 'SZ',
                name: '比亚迪',
                listingStatus: 'listed',
              },
            ],
          },
        });

        expect(summary).toEqual({
          observedCount: 2,
          createdStocks: 2,
          updatedStocks: 0,
          reactivated: 0,
          markedMissing: 0,
        });
        expect((await repos.stock.findById('600519.SH'))?.name).toBe('贵州茅台');
        expect(
          (
            await repos.stockUniverse.listCurrent({
              coverage: 'CN_A_SHARES_SH_SZ',
              status: 'active',
            })
          ).map((stock) => stock.id),
        ).toEqual(['002594.SZ', '600519.SH']);

        const latest = await repos.stockUniverse.latestSuccessfulSync({
          source: 'eastmoney',
          coverage: 'CN_A_SHARES_SH_SZ',
        });
        expect(latest?.status).toBe('succeeded');
        expect(latest?.observedCount).toBe(2);
        expect(latest?.observedAt).toEqual(observedAt);
      });

      it('同一 syncId 重放幂等', async () => {
        const input = {
          syncId: 'sync-replay',
          appliedAt: new Date('2026-07-28T08:21:00.000Z'),
          snapshot: {
            source: 'eastmoney',
            coverage: 'CN_A_SHARES_SH_SZ' as const,
            observedAt: new Date('2026-07-28T08:20:00.000Z'),
            complete: true as const,
            reportedTotal: 1,
            entries: [
              {
                stockId: '600519.SH',
                code: stockCode('600519'),
                exchange: 'SH' as const,
                name: '贵州茅台',
                listingStatus: 'listed' as const,
              },
            ],
          },
        };

        const first = await repos.stockUniverse.applySnapshot(input);
        const replay = await repos.stockUniverse.applySnapshot(input);

        expect(replay).toEqual(first);
        expect(
          await repos.stockUniverse.listCurrent({
            coverage: 'CN_A_SHARES_SH_SZ',
          }),
        ).toHaveLength(1);
      });

      it('保存成功快照成员并按 asOf 选择 PIT universe', async () => {
        const apply = (syncId: string, observedAt: Date, stockId: string) =>
          repos.stockUniverse.applySnapshot({
            syncId,
            appliedAt: observedAt,
            snapshot: {
              source: 'eastmoney',
              coverage: 'CN_A_SHARES_SH_SZ',
              observedAt,
              complete: true,
              reportedTotal: 1,
              entries: [
                {
                  stockId,
                  code: stockCode(stockId.slice(0, 6)),
                  exchange: stockId.endsWith('.SH') ? 'SH' : 'SZ',
                  name: stockId,
                  listingStatus: 'listed',
                },
              ],
            },
          });
        await apply('sync-pit-1', T1, '600519.SH');
        await apply('sync-pit-2', T3, '002594.SZ');
        const selected = await repos.stockUniverse.latestSnapshotAtOrBefore({
          coverage: 'CN_A_SHARES_SH_SZ',
          asOf: T2,
        });
        expect(selected?.id).toBe('sync-pit-1');
        expect(
          (await repos.stockUniverse.listSnapshotMembers('sync-pit-1')).map((stock) => stock.id),
        ).toEqual(['600519.SH']);
      });

      it('完整快照缺失只标记 missing，再次出现时 reactivated', async () => {
        const entryA = {
          stockId: '600519.SH',
          code: stockCode('600519'),
          exchange: 'SH' as const,
          name: '贵州茅台',
          listingStatus: 'listed' as const,
        };
        const entryB = {
          stockId: '002594.SZ',
          code: stockCode('002594'),
          exchange: 'SZ' as const,
          name: '比亚迪',
          listingStatus: 'listed' as const,
        };
        const apply = (syncId: string, observedAt: string, entries: StockUniverseEntry[]) =>
          repos.stockUniverse.applySnapshot({
            syncId,
            appliedAt: new Date(observedAt),
            snapshot: {
              source: 'eastmoney',
              coverage: 'CN_A_SHARES_SH_SZ',
              observedAt: new Date(observedAt),
              complete: true,
              reportedTotal: entries.length,
              entries,
            },
          });

        await apply('sync-full', '2026-07-27T08:20:00.000Z', [entryA, entryB]);
        const missing = await apply('sync-missing', '2026-07-28T08:20:00.000Z', [entryA]);

        expect(missing.markedMissing).toBe(1);
        expect(
          (
            await repos.stockUniverse.listCurrent({
              coverage: 'CN_A_SHARES_SH_SZ',
              status: 'missing',
            })
          ).map((stock) => stock.id),
        ).toEqual(['002594.SZ']);
        expect(await repos.stock.findById('002594.SZ')).not.toBeNull();

        const restored = await apply('sync-restored', '2026-07-29T08:20:00.000Z', [entryA, entryB]);
        expect(restored.reactivated).toBe(1);
        expect(
          await repos.stockUniverse.listCurrent({
            coverage: 'CN_A_SHARES_SH_SZ',
            status: 'missing',
          }),
        ).toEqual([]);
      });

      it('按代码和交易所复用既有 Stock 身份，并保留手工名称', async () => {
        await repos.stock.save(
          makeStock('legacy-stock-id', '600519', {
            exchange: 'SH',
            name: '我的茅台',
          }),
        );

        const summary = await repos.stockUniverse.applySnapshot({
          syncId: 'sync-existing',
          appliedAt: new Date('2026-07-28T08:21:00.000Z'),
          snapshot: {
            source: 'eastmoney',
            coverage: 'CN_A_SHARES_SH_SZ',
            observedAt: new Date('2026-07-28T08:20:00.000Z'),
            complete: true,
            reportedTotal: 1,
            entries: [
              {
                stockId: '600519.SH',
                code: stockCode('600519'),
                exchange: 'SH',
                name: '贵州茅台',
                listingStatus: 'listed',
              },
            ],
          },
        });

        expect(summary.createdStocks).toBe(0);
        expect(await repos.stock.findById('600519.SH')).toBeNull();
        expect((await repos.stock.findById('legacy-stock-id'))?.name).toBe('我的茅台');
        expect(
          (
            await repos.stockUniverse.listCurrent({
              coverage: 'CN_A_SHARES_SH_SZ',
            })
          ).map((stock) => stock.id),
        ).toEqual(['legacy-stock-id']);
      });

      it('目录名称升级 stub，并可在后续完整快照中更新', async () => {
        await repos.stock.save(
          makeStock('600519.SH', '600519', {
            exchange: 'SH',
            name: '600519',
          }),
        );
        const apply = (syncId: string, name: string) =>
          repos.stockUniverse.applySnapshot({
            syncId,
            appliedAt: new Date('2026-07-28T08:21:00.000Z'),
            snapshot: {
              source: 'eastmoney',
              coverage: 'CN_A_SHARES_SH_SZ',
              observedAt: new Date('2026-07-28T08:20:00.000Z'),
              complete: true,
              reportedTotal: 1,
              entries: [
                {
                  stockId: '600519.SH',
                  code: stockCode('600519'),
                  exchange: 'SH',
                  name,
                  listingStatus: 'listed',
                },
              ],
            },
          });

        expect((await apply('sync-stub-upgrade', '贵州茅台')).updatedStocks).toBe(1);
        expect((await repos.stock.findById('600519.SH'))?.name).toBe('贵州茅台');
        expect((await apply('sync-universe-rename', '贵州茅台股份')).updatedStocks).toBe(1);
        expect((await repos.stock.findById('600519.SH'))?.name).toBe('贵州茅台股份');
      });

      it('一个数据源 missing、另一个数据源 active 时聚合目录仍为 active', async () => {
        const stockA: StockUniverseEntry = {
          stockId: '600519.SH',
          code: stockCode('600519'),
          exchange: 'SH',
          name: '贵州茅台',
          listingStatus: 'listed',
        };
        const stockB: StockUniverseEntry = {
          stockId: '002594.SZ',
          code: stockCode('002594'),
          exchange: 'SZ',
          name: '比亚迪',
          listingStatus: 'listed',
        };
        const apply = (syncId: string, source: string, entries: StockUniverseEntry[]) =>
          repos.stockUniverse.applySnapshot({
            syncId,
            appliedAt: T2,
            snapshot: {
              source,
              coverage: 'CN_A_SHARES_SH_SZ',
              observedAt: T2,
              complete: true,
              reportedTotal: entries.length,
              entries,
            },
          });

        await apply('sync-eastmoney-a', 'eastmoney', [stockA]);
        await apply('sync-tushare-a', 'tushare', [stockA]);
        await apply('sync-eastmoney-b', 'eastmoney', [stockB]);

        expect(
          (
            await repos.stockUniverse.listCurrent({
              coverage: 'CN_A_SHARES_SH_SZ',
              status: 'active',
            })
          ).map((stock) => stock.id),
        ).toEqual(['002594.SZ', '600519.SH']);
        expect(
          await repos.stockUniverse.listCurrent({
            coverage: 'CN_A_SHARES_SH_SZ',
            status: 'missing',
          }),
        ).toEqual([]);
      });

      it('listCurrentMembers 返回当前成员与聚合挂牌状态', async () => {
        const apply = (syncId: string, entries: StockUniverseEntry[]) =>
          repos.stockUniverse.applySnapshot({
            syncId,
            appliedAt: T1,
            snapshot: {
              source: 'eastmoney',
              coverage: 'CN_A_SHARES_SH_SZ',
              observedAt: T1,
              complete: true,
              reportedTotal: entries.length,
              entries,
            },
          });
        await apply('sync-members-1', [
          {
            stockId: '600519.SH',
            code: stockCode('600519'),
            exchange: 'SH',
            name: '贵州茅台',
            listingStatus: 'listed',
          },
          {
            stockId: '002594.SZ',
            code: stockCode('002594'),
            exchange: 'SZ',
            name: '比亚迪',
            listingStatus: 'suspended',
          },
        ]);
        const members = await repos.stockUniverse.listCurrentMembers({
          coverage: 'CN_A_SHARES_SH_SZ',
        });
        expect(members.map((member) => `${member.stock.id}:${member.listingStatus}`)).toEqual([
          '002594.SZ:suspended',
          '600519.SH:listed',
        ]);
      });
    });

    describe('SectorCatalogRepository', () => {
      const TS1 = new Date('2026-11-02T00:20:00.000Z');
      const TS2 = new Date('2026-11-03T00:20:00.000Z');
      const TS3 = new Date('2026-11-04T00:20:00.000Z');
      const industry = (vendorCode: string, name: string): SectorCatalogObservation => ({
        kind: 'industry',
        vendorCode,
        name,
      });
      const concept = (vendorCode: string, name: string): SectorCatalogObservation => ({
        kind: 'concept',
        vendorCode,
        name,
      });
      const syncInput = (
        overrides: Partial<SectorSyncApplyInput> & { readonly syncId: string },
      ): SectorSyncApplyInput => ({
        source: 'fuyao',
        appliedAt: TS1,
        status: 'succeeded',
        catalog: [industry('881273.TI', '白酒'), concept('886042.TI', '白酒概念')],
        catalogKinds: ['industry', 'concept'] satisfies SectorKind[],
        observations: [
          {
            stockId: '600519.SH',
            sectors: [industry('881273.TI', '白酒'), concept('886042.TI', '白酒概念')],
          },
          {
            stockId: '000858.SZ',
            sectors: [industry('881273.TI', '白酒'), concept('886042.TI', '白酒概念')],
          },
        ],
        stockStatuses: [
          { stockId: '600519.SH', status: 'listed' },
          { stockId: '000858.SZ', status: 'suspended' },
        ],
        failures: [],
        ...overrides,
      });

      it('首次同步建立目录与多对多成分，按股票反查含来源与时点', async () => {
        const summary = await repos.sectorCatalog.applySync(syncInput({ syncId: 'sector-1' }));

        expect(summary).toEqual({
          observedSectors: 2,
          createdSectors: 2,
          renamedSectors: 0,
          retiredSectors: 0,
          observedStocks: 2,
          createdMemberships: 4,
          removedMemberships: 0,
          reactivatedMemberships: 0,
        });
        const sectors = await repos.sectorCatalog.listSectors();
        expect(sectors.map((sector) => `${sector.kind}:${sector.vendorCode}`)).toEqual([
          'concept:886042.TI',
          'industry:881273.TI',
        ]);
        // 内部标识与供应商编码分别标识，不互相顶替。
        for (const sector of sectors) expect(sector.id).not.toBe(sector.vendorCode);

        const views = await repos.sectorCatalog.listByStock({
          stockIds: ['600519.SH'],
          kinds: ['concept'],
        });
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({
          stockId: '600519.SH',
          kind: 'concept',
          vendorCode: '886042.TI',
          name: '白酒概念',
          source: 'fuyao',
          state: 'active',
          memberStatus: 'listed',
          firstSeenAt: TS1,
          lastSeenAt: TS1,
          missingSince: null,
        });
        expect(
          (await repos.sectorCatalog.listByStock({ stockIds: ['000858.SZ'] })).map(
            (view) => view.memberStatus,
          ),
        ).toEqual(['suspended', 'suspended']);
      });

      it('同一 syncId 重放与重复执行都不产生重复关系或重复变更', async () => {
        const input = syncInput({ syncId: 'sector-replay' });
        const first = await repos.sectorCatalog.applySync(input);
        const replay = await repos.sectorCatalog.applySync(input);
        expect(replay).toEqual(first);

        const repeat = await repos.sectorCatalog.applySync(
          syncInput({ syncId: 'sector-replay-2', appliedAt: TS2 }),
        );
        expect(repeat.createdMemberships).toBe(0);
        expect(await repos.sectorCatalog.listByStock({ stockIds: ['600519.SH'] })).toHaveLength(2);
        expect(
          (await repos.sectorCatalog.listChanges({ stockId: '600519.SH' })).map(
            (change) => change.kind,
          ),
        ).toEqual(['member-entered', 'member-entered']);
        expect(
          (await repos.sectorCatalog.listChanges()).filter(
            (change) => change.kind === 'sector-created',
          ),
        ).toHaveLength(2);
      });

      it('目录改名与下线写变更记录，历史条目仍可读取', async () => {
        await repos.sectorCatalog.applySync(
          syncInput({
            syncId: 'sector-history-1',
            catalog: [industry('881101.TI', '种植业'), industry('881273.TI', '白酒')],
            catalogKinds: ['industry'],
            observations: [],
          }),
        );
        const renamed = await repos.sectorCatalog.applySync(
          syncInput({
            syncId: 'sector-history-2',
            appliedAt: TS2,
            catalog: [industry('881273.TI', '白酒Ⅱ')],
            catalogKinds: ['industry'],
            observations: [],
          }),
        );

        expect(renamed.renamedSectors).toBe(1);
        expect(renamed.retiredSectors).toBe(1);
        const all = await repos.sectorCatalog.listSectors({ state: 'all' });
        expect(all.map((sector) => `${sector.vendorCode}:${sector.name}:${sector.state}`)).toEqual([
          '881101.TI:种植业:retired',
          '881273.TI:白酒Ⅱ:active',
        ]);
        // 默认只返回当前有效目录；下线条目不覆盖历史。
        expect(
          (await repos.sectorCatalog.listSectors()).map((sector) => sector.vendorCode),
        ).toEqual(['881273.TI']);

        const renamedSector = all.find((sector) => sector.vendorCode === '881273.TI');
        expect(renamedSector).toBeDefined();
        if (renamedSector === undefined) return;
        const renamedChanges = await repos.sectorCatalog.listChanges({
          sectorId: renamedSector.id,
        });
        expect(renamedChanges.map((change) => change.kind)).toEqual([
          'sector-created',
          'sector-renamed',
        ]);
        expect(renamedChanges[1]).toMatchObject({
          previousValue: '白酒',
          nextValue: '白酒Ⅱ',
          occurredAt: TS2,
        });
      });

      it('部分响应失败时未观测股票与未成功分类保持原状', async () => {
        await repos.sectorCatalog.applySync(syncInput({ syncId: 'sector-partial-1' }));

        // concept 目录请求失败（catalogKinds 里没有 concept），且 000858.SZ 批次失败未被观测。
        const partial = await repos.sectorCatalog.applySync(
          syncInput({
            syncId: 'sector-partial-2',
            appliedAt: TS2,
            status: 'partial',
            catalog: [industry('881273.TI', '白酒')],
            catalogKinds: ['industry'],
            observations: [
              {
                stockId: '600519.SH',
                sectors: [industry('881273.TI', '白酒')],
              },
            ],
            failures: [
              {
                scope: 'catalog',
                kind: 'concept',
                message: 'fuyao upstream_error: concept catalog',
              },
              { scope: 'memberships', kind: null, message: 'fuyao network: batch 000858.SZ' },
            ],
          }),
        );

        expect(partial.removedMemberships).toBe(1);
        expect(partial.retiredSectors).toBe(0);
        // 000858.SZ 未被观测 → 两条成分都保持 active，只按目录状态更新为 suspended。
        const unobserved = await repos.sectorCatalog.listByStock({ stockIds: ['000858.SZ'] });
        expect(unobserved.map((view) => `${view.vendorCode}:${view.state}`)).toEqual([
          '886042.TI:active',
          '881273.TI:active',
        ]);
        expect(unobserved.every((view) => view.memberStatus === 'suspended')).toBe(true);
        // concept 目录没有成功返回 → 不下线。
        expect(
          (await repos.sectorCatalog.listSectors({ kinds: ['concept'] })).map(
            (sector) => sector.vendorCode,
          ),
        ).toEqual(['886042.TI']);
        // 被观测到的 600519.SH 少了一条概念关系 → 只退该条。
        expect(
          (
            await repos.sectorCatalog.listByStock({
              stockIds: ['600519.SH'],
              includeMissing: true,
            })
          ).map((view) => `${view.vendorCode}:${view.state}`),
        ).toEqual(['886042.TI:missing', '881273.TI:active']);
      });

      it('成分重新出现时恢复 active 并保留首次观测时间', async () => {
        await repos.sectorCatalog.applySync(syncInput({ syncId: 'sector-rejoin-1' }));
        await repos.sectorCatalog.applySync(
          syncInput({
            syncId: 'sector-rejoin-2',
            appliedAt: TS2,
            catalog: [industry('881273.TI', '白酒')],
            observations: [{ stockId: '600519.SH', sectors: [industry('881273.TI', '白酒')] }],
          }),
        );
        const rejoined = await repos.sectorCatalog.applySync(
          syncInput({ syncId: 'sector-rejoin-3', appliedAt: TS3 }),
        );

        expect(rejoined.reactivatedMemberships).toBe(1);
        const views = await repos.sectorCatalog.listByStock({ stockIds: ['600519.SH'] });
        const conceptView = views.find((view) => view.vendorCode === '886042.TI');
        expect(conceptView).toMatchObject({
          state: 'active',
          missingSince: null,
          firstSeenAt: TS1,
          lastSeenAt: TS3,
        });
        const changes = await repos.sectorCatalog.listChanges({ stockId: '600519.SH' });
        expect(changes.map((change) => change.kind)).toEqual([
          'member-entered',
          'member-entered',
          'member-left',
          'member-rejoined',
        ]);
      });

      it('按板块读取成分默认只返回 active，可显式包含已退出成员', async () => {
        await repos.sectorCatalog.applySync(syncInput({ syncId: 'sector-by-sector-1' }));
        await repos.sectorCatalog.applySync(
          syncInput({
            syncId: 'sector-by-sector-2',
            appliedAt: TS2,
            observations: [{ stockId: '600519.SH', sectors: [] }],
          }),
        );
        const conceptSector = (await repos.sectorCatalog.listSectors({ kinds: ['concept'] }))[0];
        expect(conceptSector).toBeDefined();
        if (conceptSector === undefined) return;
        expect(
          (await repos.sectorCatalog.listBySector({ sectorId: conceptSector.id })).map(
            (member) => member.stockId,
          ),
        ).toEqual(['000858.SZ']);
        expect(
          (
            await repos.sectorCatalog.listBySector({
              sectorId: conceptSector.id,
              includeMissing: true,
            })
          ).map((member) => `${member.stockId}:${member.state}`),
        ).toEqual(['000858.SZ:active', '600519.SH:missing']);
      });
    });

    describe('HoldingRepository', () => {
      it('save + findById / findByAccountAndStock / listByAccount 往返一致', async () => {
        const h1 = makeHolding('h-1');
        const h2 = makeHolding('h-2', { stockId: 'stk-2' });
        const h3 = makeHolding('h-3', { accountId: 'acc-2' });
        await repos.holding.save(h1);
        await repos.holding.save(h2);
        await repos.holding.save(h3);
        expect(await repos.holding.findById('h-1')).toEqual(h1);
        expect(await repos.holding.findByAccountAndStock('acc-1', 'stk-2')).toEqual(h2);
        expect(await repos.holding.findByAccountAndStock('acc-1', 'stk-x')).toBeNull();
        expect((await repos.holding.listByAccount('acc-1')).map((h) => h.id)).toEqual([
          'h-1',
          'h-2',
        ]);
      });

      it('closedAt 非空往返（已平仓）', async () => {
        const closed = makeHolding('h-c', { closedAt: T2 });
        await repos.holding.save(closed);
        expect(await repos.holding.findById('h-c')).toEqual(closed);
      });

      it('同 (accountId, stockId) 不同 id → 拒绝（holdings 无重复）', async () => {
        await repos.holding.save(makeHolding('h-1'));
        await expect(repos.holding.save(makeHolding('h-2'))).rejects.toThrow(InvariantError);
      });

      it('违反不变量时拒绝（availableQuantity > quantity）', async () => {
        const bad = makeHolding('h-bad', { quantity: 100, availableQuantity: 200 });
        await expect(repos.holding.save(bad)).rejects.toThrow(InvariantError);
      });

      it('save 同 id 为 upsert；remove 生效', async () => {
        await repos.holding.save(makeHolding('h-1', { quantity: 100, availableQuantity: 50 }));
        await repos.holding.save(makeHolding('h-1', { quantity: 200, availableQuantity: 150 }));
        expect((await repos.holding.findById('h-1'))?.quantity).toBe(200);
        await repos.holding.remove('h-1');
        expect(await repos.holding.findById('h-1')).toBeNull();
      });
    });

    describe('TradeRepository', () => {
      it('save + findById 往返一致', async () => {
        const trade = makeTrade('t-1');
        await repos.trade.save(trade);
        expect(await repos.trade.findById('t-1')).toEqual(trade);
        expect(await repos.trade.findById('missing')).toBeNull();
      });

      it('决策归因字段可空且 memory/Drizzle 往返一致', async () => {
        const trade = makeTrade('t-attributed', {
          adviceId: 'advice-1',
          strategyVersionId: 'strategy-v1',
        });
        await repos.trade.save(trade);
        expect(await repos.trade.findById(trade.id)).toEqual(trade);
        await repos.trade.save(makeTrade('t-legacy'));
        expect(await repos.trade.findById('t-legacy')).toEqual(makeTrade('t-legacy'));
      });

      it('listByAccount 按 executedAt 升序', async () => {
        await repos.trade.save(makeTrade('t-2', { executedAt: T3 }));
        await repos.trade.save(makeTrade('t-1', { executedAt: T1 }));
        await repos.trade.save(makeTrade('t-9', { accountId: 'acc-2', executedAt: T0 }));
        const list = await repos.trade.listByAccount('acc-1');
        expect(list.map((t) => t.id)).toEqual(['t-1', 't-2']);
      });

      it('listByAccount 先按账户、股票和包含起点的时间过滤，再稳定排序和截取', async () => {
        for (const trade of [
          makeTrade('before', { executedAt: T0 }),
          makeTrade('boundary', { executedAt: T1 }),
          makeTrade('latest-a', { executedAt: T2 }),
          makeTrade('latest-b', { executedAt: T2 }),
          makeTrade('other-stock', { stockId: 'stk-2', executedAt: T3 }),
          makeTrade('other-account', { accountId: 'acc-2', executedAt: T3 }),
        ])
          await repos.trade.save(trade);
        const filter = { stockId: 'stk-1', executedAtFrom: T1 };
        expect((await repos.trade.listByAccount('acc-1', filter)).map((t) => t.id)).toEqual([
          'boundary',
          'latest-a',
          'latest-b',
        ]);
        expect(
          (await repos.trade.listByAccount('acc-1', { ...filter, order: 'desc', limit: 2 })).map(
            (t) => t.id,
          ),
        ).toEqual(['latest-b', 'latest-a']);
        expect(await repos.trade.listByAccount('acc-1', { ...filter, executedAtFrom: T3 })).toEqual(
          [],
        );
      });

      it('违反不变量时拒绝（quantity <= 0 / price <= 0 / fee < 0）', async () => {
        await expect(
          repos.trade.save(makeTrade('t-bad-1', { quantity: quantity(0) })),
        ).rejects.toThrow(InvariantError);
        await expect(repos.trade.save(makeTrade('t-bad-2', { price: money(-1) }))).rejects.toThrow(
          InvariantError,
        );
        await expect(repos.trade.save(makeTrade('t-bad-3', { fee: money(-0.01) }))).rejects.toThrow(
          InvariantError,
        );
      });

      it('save 同 id 为 upsert；remove 生效', async () => {
        await repos.trade.save(makeTrade('t-1', { side: 'buy' }));
        await repos.trade.save(makeTrade('t-1', { side: 'sell' }));
        expect((await repos.trade.findById('t-1'))?.side).toBe('sell');
        await repos.trade.remove('t-1');
        expect(await repos.trade.findById('t-1')).toBeNull();
      });
    });

    describe('LedgerRepository（账户事实原子写入）', () => {
      const makeFlow = (
        id: string,
        overrides: Partial<PortfolioCashFlow> = {},
      ): PortfolioCashFlow => ({
        id,
        accountId: 'acc-1',
        occurredAt: T1,
        kind: 'deposit',
        amount: 10_000,
        currency: 'CNY',
        source: 'manual',
        createdAt: T1,
        ...overrides,
      });

      it('applyTrade 同一次提交写入账户余额 + 交易 + 持仓', async () => {
        await repos.account.save(makeAccount('acc-1', { cashBalance: money(100_000) }));
        const trade = makeTrade('t-ledger', { price: money(10), quantity: quantity(100) });
        const holding = makeHolding('h-ledger', { quantity: 100, availableQuantity: 100 });

        await repos.ledger.applyTrade({
          previousHolding: null,
          trade,
          holding,
        });

        expect((await repos.account.findById('acc-1'))?.cashBalance).toBe(99_000);
        expect(await repos.trade.findById('t-ledger')).toEqual(trade);
        expect(await repos.holding.findById('h-ledger')).toEqual(holding);
      });

      it('applyHolding 只改余额与持仓', async () => {
        await repos.account.save(makeAccount('acc-1', { cashBalance: money(100_000) }));
        const holding = makeHolding('h-ledger-2', {
          quantity: 200,
          availableQuantity: 200,
          avgCost: money(10),
        });

        await repos.ledger.applyHolding({
          previousHolding: null,
          occurredAt: T1,
          holding,
        });

        expect((await repos.account.findById('acc-1'))?.cashBalance).toBe(98_000);
        expect(await repos.holding.findById('h-ledger-2')).toEqual(holding);
      });

      it('applyCashFlow 同一次提交写入账户余额 + 资金流水', async () => {
        await repos.account.save(makeAccount('acc-1', { cashBalance: money(100_000) }));
        const flow = makeFlow('flow-ledger');

        await repos.ledger.applyCashFlow({
          flow,
        });

        expect((await repos.account.findById('acc-1'))?.cashBalance).toBe(110_000);
        expect(await repos.portfolioCashFlow.findById('flow-ledger')).toEqual(flow);
      });

      it('并发现金流不会丢失余额更新，且不会超额出金', async () => {
        await repos.account.save(makeAccount('acc-1', { cashBalance: money(1000) }));
        await Promise.all(
          [100, 200].map((amount) =>
            repos.ledger.applyCashFlow({ flow: makeFlow(`deposit-${amount}`, { amount }) }),
          ),
        );
        expect((await repos.account.findById('acc-1'))?.cashBalance).toBe(1300);
        const withdrawals = await Promise.allSettled(
          [1, 2].map((n) =>
            repos.ledger.applyCashFlow({
              flow: makeFlow(`withdrawal-${n}`, { amount: 1000, kind: 'withdrawal' }),
            }),
          ),
        );
        expect(withdrawals.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect((await repos.account.findById('acc-1'))?.cashBalance).toBe(300);
        expect(await repos.portfolioCashFlow.listByAccount('acc-1')).toHaveLength(3);
      });

      it('过期持仓更新被拒绝，现金与调整记录不被重复写入', async () => {
        await repos.account.save(makeAccount('acc-1', { cashBalance: money(100000) }));
        const holding = makeHolding('concurrent', {
          quantity: 100,
          availableQuantity: 100,
          avgCost: money(10),
        });
        const results = await Promise.allSettled(
          [1, 2].map(() =>
            repos.ledger.applyHolding({ previousHolding: null, holding, occurredAt: T1 }),
          ),
        );
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect((await repos.account.findById('acc-1'))?.cashBalance).toBe(99000);
        expect(await repos.ledger.listHoldingAdjustments('acc-1')).toMatchObject([
          { amount: -1000, quantityDelta: 100 },
        ]);
        expect(await repos.ledger.listHoldingAdjustments('acc-2')).toEqual([]);
      });

      it('持仓登记后卖出，重算仍保留登记成本', async () => {
        const account = makeAccount('acc-1', {
          initialCapital: money(100000),
          cashBalance: money(100000),
        });
        await repos.account.save(account);
        const holding = makeHolding('registered', {
          quantity: 100,
          availableQuantity: 100,
          avgCost: money(10),
        });
        await repos.ledger.applyHolding({ previousHolding: null, holding, occurredAt: T1 });
        await repos.ledger.applyTrade({
          previousHolding: holding,
          trade: makeTrade('sold', { side: 'sell', quantity: quantity(100), price: money(12) }),
          holding: { ...holding, quantity: 0, availableQuantity: 0, closedAt: T2 },
        });
        const stored = await repos.account.findById('acc-1');
        expect(stored?.cashBalance).toBe(100200);
        if (stored === null) throw new Error('ledger account missing');
        const result = reconcileCashBalance(stored, {
          account,
          holdings: await repos.holding.listByAccount('acc-1'),
          trades: await repos.trade.listByAccount('acc-1'),
          cashFlows: [],
          holdingAdjustments: await repos.ledger.listHoldingAdjustments('acc-1'),
        });
        expect(result).toMatchObject({ reconciled: true, difference: 0, gaps: [] });
      });

      it('违反不变量时整笔拒绝（不写余额也不写事实）', async () => {
        await repos.account.save(makeAccount('acc-1', { cashBalance: money(100_000) }));
        await expect(
          repos.ledger.applyHolding({
            previousHolding: null,
            occurredAt: T1,
            holding: makeHolding('h-ledger-3', { avgCost: money(1000) }),
          }),
        ).rejects.toThrow(InvariantError);
        expect((await repos.account.findById('acc-1'))?.cashBalance).toBe(100_000);
        expect(await repos.holding.findById('h-ledger-3')).toBeNull();
      });
    });

    describe('Portfolio performance repositories', () => {
      it('现金流按账户和时间范围隔离，支持 upsert/remove', async () => {
        const flow: PortfolioCashFlow = {
          id: 'flow-1',
          accountId: 'acc-1',
          occurredAt: T1,
          kind: 'deposit',
          amount: 10_000,
          currency: 'CNY',
          source: 'manual',
          createdAt: T1,
        };
        await repos.portfolioCashFlow.save(flow);
        await repos.portfolioCashFlow.save({ ...flow, amount: 12_000 });
        expect(await repos.portfolioCashFlow.findById(flow.id)).toEqual({
          ...flow,
          amount: 12_000,
        });
        expect(await repos.portfolioCashFlow.listByAccount('acc-1', T1, T1)).toHaveLength(1);
        expect(await repos.portfolioCashFlow.listByAccount('acc-2')).toEqual([]);
        await repos.portfolioCashFlow.remove(flow.id);
        expect(await repos.portfolioCashFlow.findById(flow.id)).toBeNull();
      });

      it('公司行动按账户隔离并保留可选字段', async () => {
        const action: PortfolioCorporateAction = {
          id: 'action-1',
          accountId: 'acc-1',
          stockId: 'stk-1',
          occurredAt: T2,
          kind: 'split',
          ratio: 2,
          source: 'import',
          createdAt: T2,
        };
        await repos.portfolioCorporateAction.save(action);
        expect(await repos.portfolioCorporateAction.findById(action.id)).toEqual(action);
        expect(await repos.portfolioCorporateAction.listByAccount('acc-2')).toEqual([]);
        await expect(
          repos.portfolioCorporateAction.save({
            ...action,
            id: 'action-bad',
            ratio: undefined,
          }),
        ).rejects.toThrow();
        await repos.portfolioCorporateAction.remove(action.id);
        expect(await repos.portfolioCorporateAction.findById(action.id)).toBeNull();
      });

      it('绩效快照按输入指纹幂等复用，并按账户/时间倒序查询', async () => {
        const snapshot: PortfolioPerformanceSnapshot = {
          id: 'performance-snapshot-1',
          accountId: 'acc-1',
          from: T1,
          to: T2,
          currency: 'CNY',
          inputFingerprint: 'fingerprint-1',
          calculatedAt: T2,
          dataAsOf: T2,
          performance: {
            accountId: 'acc-1',
            from: T1,
            to: T2,
            currency: 'CNY',
            completeness: 'complete',
            cashFlowComplete: true,
            benchmarkStatus: 'unavailable',
            realizedPnl: 0,
            valuation: [],
            contributions: [],
            warnings: [],
          },
        };
        await repos.portfolioPerformanceSnapshot.save(snapshot);
        await repos.portfolioPerformanceSnapshot.save({ ...snapshot, calculatedAt: T3 });
        expect(
          await repos.portfolioPerformanceSnapshot.findByFingerprint({
            accountId: snapshot.accountId,
            from: snapshot.from,
            to: snapshot.to,
            inputFingerprint: snapshot.inputFingerprint,
          }),
        ).toMatchObject({ id: snapshot.id, calculatedAt: T3 });
        expect(await repos.portfolioPerformanceSnapshot.listByAccount('acc-1')).toHaveLength(1);
        expect(
          await repos.portfolioPerformanceSnapshot.listByAccountAndRange('acc-1', T1, T2),
        ).toHaveLength(1);
        expect(
          await repos.portfolioPerformanceSnapshot.listByAccountAndRange('acc-1', T3, T3),
        ).toEqual([]);
        expect(await repos.portfolioPerformanceSnapshot.listByAccount('acc-2')).toEqual([]);
        await repos.portfolioPerformanceSnapshot.remove(snapshot.id);
        expect(await repos.portfolioPerformanceSnapshot.findById(snapshot.id)).toBeNull();
      });
    });

    describe('AdviceRepository', () => {
      it('save + findById 往返一致（含 basedOn 快照的 Date 字段）', async () => {
        const advice = makeAdvice('adv-1', {
          basedOn: {
            quotes: {
              'stk-1': {
                stockId: 'stk-1',
                observedAt: T2,
                fetchedAt: T2,
                timestampSource: 'retrieval',
                ts: T2,
                open: money(10),
                high: money(11),
                low: money(9),
                close: money(10.5),
                volume: 1_234_567,
                source: 'test',
              },
            },
            indicators: { 'stk-1': { ma5: 10.2, rsi14: 55 } },
            llmReasoning: '原始推理文本',
            strategy: {
              strategyId: 'strategy-1',
              strategyVersionId: 'strategy-version-1',
              runId: 'strategy-run-1',
              stockId: 'stk-1',
              score: 82,
              rank: 1,
              resultEvidence: ['result-fact'],
              signalIds: ['signal-1'],
              observationIds: ['observation-1'],
              recommendationTrigger: 'run',
            },
            dataAsOf: T3,
          },
        });
        await repos.advice.save(advice);
        const got = await repos.advice.findById('adv-1');
        expect(got).toEqual(advice);
        expect(got?.basedOn.dataAsOf).toBeInstanceOf(Date);
        expect(got?.basedOn.quotes?.['stk-1']?.ts).toBeInstanceOf(Date);
      });

      it('sourceTool / sourceWorkflow 可选字段往返', async () => {
        const minimal = makeAdvice('adv-min');
        const { sourceTool: _drop, ...withoutSourceTool } = minimal;
        await repos.advice.save(withoutSourceTool);
        const got = await repos.advice.findById('adv-min');
        expect(got).toEqual(withoutSourceTool);
        expect(got?.sourceTool).toBeUndefined();

        const withWorkflow = makeAdvice('adv-wf', { sourceWorkflow: 'daily-advice' });
        await repos.advice.save(withWorkflow);
        expect((await repos.advice.findById('adv-wf'))?.sourceWorkflow).toBe('daily-advice');
      });

      it('违反不变量时拒绝（confidence 越界 / 缺 disclaimer）', async () => {
        await expect(
          repos.advice.save(makeAdvice('adv-bad-1', { confidence: 101 })),
        ).rejects.toThrow(InvariantError);
        await expect(
          repos.advice.save(makeAdvice('adv-bad-2', { disclaimers: [] })),
        ).rejects.toThrow(InvariantError);
      });

      it('query 按 subjectId / subjectKind / decision / sourceTool 过滤', async () => {
        await repos.advice.save(makeAdvice('adv-1', { createdAt: T1 }));
        await repos.advice.save(
          makeAdvice('adv-2', { subjectId: 'stk-2', decision: 'buy', createdAt: T2 }),
        );
        await repos.advice.save(
          makeAdvice('adv-3', {
            subjectKind: 'market',
            subjectId: 'A股',
            sourceTool: 'market_outlook',
            createdAt: T3,
          }),
        );
        expect((await repos.advice.query({ subjectId: 'stk-1' })).map((a) => a.id)).toEqual([
          'adv-1',
        ]);
        expect((await repos.advice.query({ subjectKind: 'market' })).map((a) => a.id)).toEqual([
          'adv-3',
        ]);
        expect((await repos.advice.query({ decision: 'buy' })).map((a) => a.id)).toEqual(['adv-2']);
        expect(
          (await repos.advice.query({ sourceTool: 'market_outlook' })).map((a) => a.id),
        ).toEqual(['adv-3']);
        // 无过滤：全部按 createdAt 倒序
        expect((await repos.advice.query({})).map((a) => a.id)).toEqual([
          'adv-3',
          'adv-2',
          'adv-1',
        ]);
      });

      it('query 按 since / until 过滤（createdAt 闭区间）', async () => {
        await repos.advice.save(makeAdvice('adv-1', { createdAt: T1 }));
        await repos.advice.save(makeAdvice('adv-2', { createdAt: T2 }));
        await repos.advice.save(makeAdvice('adv-3', { createdAt: T3 }));
        expect((await repos.advice.query({ since: T2 })).map((a) => a.id)).toEqual([
          'adv-3',
          'adv-2',
        ]);
        expect((await repos.advice.query({ until: T2 })).map((a) => a.id)).toEqual([
          'adv-2',
          'adv-1',
        ]);
        expect((await repos.advice.query({ since: T1, until: T2 })).map((a) => a.id)).toEqual([
          'adv-2',
          'adv-1',
        ]);
      });

      it('query 默认不返回过期 advice；includeExpired: true 返回', async () => {
        await repos.advice.save(makeAdvice('adv-live', { validFrom: T1, validUntil: FAR_FUTURE }));
        await repos.advice.save(makeAdvice('adv-dead', { validFrom: FAR_PAST, validUntil: T1 }));
        expect((await repos.advice.query({})).map((a) => a.id)).toEqual(['adv-live']);
        expect((await repos.advice.query({ includeExpired: true })).map((a) => a.id)).toEqual([
          'adv-live',
          'adv-dead',
        ]);
      });

      it('query 支持 limit', async () => {
        await repos.advice.save(makeAdvice('adv-1', { createdAt: T1 }));
        await repos.advice.save(makeAdvice('adv-2', { createdAt: T2 }));
        await repos.advice.save(makeAdvice('adv-3', { createdAt: T3 }));
        expect((await repos.advice.query({ limit: 2 })).map((a) => a.id)).toEqual([
          'adv-3',
          'adv-2',
        ]);
      });

      it('save 同 id 为 upsert', async () => {
        await repos.advice.save(makeAdvice('adv-1', { decision: 'hold' }));
        await repos.advice.save(makeAdvice('adv-1', { decision: 'buy' }));
        expect((await repos.advice.findById('adv-1'))?.decision).toBe('buy');
      });

      it('recordOutcome 回填 + 读取；重复回填覆盖', async () => {
        const advice = makeAdvice('adv-1');
        await repos.advice.save(advice);
        expect(await handle.readOutcome('adv-1')).toBeNull();

        const outcome: AdviceOutcome = {
          adviceId: 'adv-1',
          tradeIds: ['trade-1'],
          outcome: 'followed',
          pnl: money(123.4567),
          benchmarkPnl: money(50),
          holdingHours: 12,
          notes: '复盘备注',
          recordedAt: T3,
        };
        await repos.advice.recordOutcome('adv-1', outcome);
        expect(await handle.readOutcome('adv-1')).toEqual(outcome);
        expect(await repos.advice.findOutcome('adv-1')).toEqual(outcome);
        expect(await repos.advice.listOutcomes({ since: T2, until: T3 })).toEqual([outcome]);
        expect(await repos.advice.listOutcomes({ since: FAR_FUTURE })).toEqual([]);

        await repos.advice.save(makeAdvice('adv-2', { subjectId: 'stk-2' }));
        const otherOutcome: AdviceOutcome = {
          adviceId: 'adv-2',
          tradeIds: [],
          outcome: 'ignored',
          recordedAt: T2,
        };
        await repos.advice.recordOutcome('adv-2', otherOutcome);
        expect(await repos.advice.listOutcomes({ subjectId: 'stk-2' })).toEqual([otherOutcome]);

        const updated: AdviceOutcome = {
          adviceId: 'adv-1',
          tradeIds: [],
          outcome: 'ignored',
          recordedAt: T3,
        };
        await repos.advice.recordOutcome('adv-1', updated);
        expect(await handle.readOutcome('adv-1')).toEqual(updated);
      });

      it('recordOutcome 的 adviceId 不一致时拒绝', async () => {
        const outcome: AdviceOutcome = {
          adviceId: 'adv-x',
          tradeIds: [],
          outcome: 'ignored',
          recordedAt: T3,
        };
        await expect(repos.advice.recordOutcome('adv-y', outcome)).rejects.toThrow(InvariantError);
      });

      it('remove 删除建议并级联清理 outcome；删除不存在 id 为幂等空操作', async () => {
        await repos.advice.save(makeAdvice('adv-1'));
        await repos.advice.save(makeAdvice('adv-2'));
        const outcome: AdviceOutcome = {
          adviceId: 'adv-1',
          tradeIds: [],
          outcome: 'followed',
          recordedAt: T3,
        };
        await repos.advice.recordOutcome('adv-1', outcome);

        await repos.advice.remove('adv-1');
        expect(await repos.advice.findById('adv-1')).toBeNull();
        expect(await repos.advice.findOutcome('adv-1')).toBeNull();
        expect(await repos.advice.listOutcomes({})).toEqual([]);
        expect((await repos.advice.query({})).map((a) => a.id)).toEqual(['adv-2']);

        await repos.advice.remove('adv-1');
        await repos.advice.remove('adv-missing');
        expect((await repos.advice.query({})).map((a) => a.id)).toEqual(['adv-2']);
      });
    });

    describe('QuoteRepository', () => {
      it('save + latestByStock 返回最新一条', async () => {
        await repos.quote.save(makeQuote('stk-1', T1, { close: money(10) }));
        await repos.quote.save(makeQuote('stk-1', T2, { close: money(11) }));
        await repos.quote.save(makeQuote('stk-1', T3, { close: money(12) }));
        const latest = await repos.quote.latestByStock('stk-1');
        expect(latest?.ts.getTime()).toBe(T3.getTime());
        expect(latest?.close).toBe(12);
      });

      it('latestByStock(since) 仅返回 ≥ since 的最新', async () => {
        await repos.quote.save(makeQuote('stk-1', T1));
        await repos.quote.save(makeQuote('stk-1', T3));
        const got = await repos.quote.latestByStock('stk-1', T2);
        expect(got?.ts.getTime()).toBe(T3.getTime());
        const none = await repos.quote.latestByStock('stk-1', T3);
        expect(none?.ts.getTime()).toBe(T3.getTime());
        const empty = await repos.quote.latestByStock('stk-1', new Date('2099-01-01'));
        expect(empty).toBeNull();
      });

      it('latestByStocks 多股一次查', async () => {
        await repos.quote.save(makeQuote('stk-1', T1));
        await repos.quote.save(makeQuote('stk-1', T2));
        await repos.quote.save(makeQuote('stk-2', T3));
        const got = await repos.quote.latestByStocks(['stk-1', 'stk-2', 'stk-missing']);
        expect(got.get('stk-1')?.ts.getTime()).toBe(T2.getTime());
        expect(got.get('stk-2')?.ts.getTime()).toBe(T3.getTime());
        expect(got.has('stk-missing')).toBe(false);
      });

      it('listInRange 按 ts 升序返回区间内快照', async () => {
        await repos.quote.save(makeQuote('stk-1', T1));
        await repos.quote.save(makeQuote('stk-1', T2));
        await repos.quote.save(makeQuote('stk-1', T3));
        const got = await repos.quote.listInRange('stk-1', T1, T2);
        expect(got.map((q) => q.ts.getTime())).toEqual([T1.getTime(), T2.getTime()]);
      });

      it('save 同 (stockId, observedAt, source) 为 upsert', async () => {
        await repos.quote.save(makeQuote('stk-1', T2, { close: money(10) }));
        await repos.quote.save(makeQuote('stk-1', T2, { close: money(99) }));
        expect((await repos.quote.latestByStock('stk-1'))?.close).toBe(99);
      });

      it('同一 observedAt 的不同 source 共存，latest 取 fetchedAt 更新者', async () => {
        await repos.quote.save(
          makeQuote('stk-1', T2, {
            source: 'source-a',
            fetchedAt: T2,
            close: money(10),
          }),
        );
        await repos.quote.save(
          makeQuote('stk-1', T2, {
            source: 'source-b',
            fetchedAt: T3,
            timestampSource: 'upstream',
            close: money(11),
          }),
        );
        expect(await repos.quote.listInRange('stk-1', T2, T2)).toHaveLength(2);
        expect((await repos.quote.latestByStock('stk-1'))?.source).toBe('source-b');
      });

      it('prevClose 随快照持久化；缺省读回为 undefined', async () => {
        await repos.quote.save(makeQuote('stk-1', T1, { prevClose: money(9.8) }));
        await repos.quote.save(makeQuote('stk-2', T1));
        expect((await repos.quote.latestByStock('stk-1'))?.prevClose).toBe(9.8);
        expect((await repos.quote.latestByStock('stk-2'))?.prevClose).toBeUndefined();
      });

      it('amount / turnoverRatePct 随快照持久化；缺省读回 undefined；同主键重复 save 读回新字段', async () => {
        await repos.quote.save(
          makeQuote('stk-1', T1, { amount: 1_410_000_000, turnoverRatePct: 0.22 }),
        );
        await repos.quote.save(makeQuote('stk-2', T1));
        const withFields = await repos.quote.latestByStock('stk-1');
        expect(withFields?.amount).toBe(1_410_000_000);
        expect(withFields?.turnoverRatePct).toBe(0.22);
        const without = await repos.quote.latestByStock('stk-2');
        expect(without?.amount).toBeUndefined();
        expect(without?.turnoverRatePct).toBeUndefined();
        await repos.quote.save(makeQuote('stk-1', T1, { amount: 2_000_000, turnoverRatePct: 0.5 }));
        const updated = await repos.quote.latestByStock('stk-1');
        expect(updated?.amount).toBe(2_000_000);
        expect(updated?.turnoverRatePct).toBe(0.5);
      });

      it('股本、市值和估值字段随快照持久化，缺省读回 undefined', async () => {
        await repos.quote.save(
          makeQuote('stk-1', T1, {
            totalShares: 2_000_000_000,
            floatShares: 1_800_000_000,
            totalMarketCap: 200_000_000_000,
            floatMarketCap: 180_000_000_000,
            peDynamic: 18.2,
            peTtm: 19.6,
            peStatic: 21.4,
            psTtm: 2.7,
            pb: 3.8,
          }),
        );
        await repos.quote.save(makeQuote('stk-2', T1));
        expect(await repos.quote.latestByStock('stk-1')).toMatchObject({
          totalShares: 2_000_000_000,
          floatMarketCap: 180_000_000_000,
          peTtm: 19.6,
          psTtm: 2.7,
          pb: 3.8,
        });
        expect((await repos.quote.latestByStock('stk-2'))?.totalMarketCap).toBeUndefined();
      });

      it('removeInRange 返回删除条数；after 不动', async () => {
        await repos.quote.save(makeQuote('stk-1', T1));
        await repos.quote.save(makeQuote('stk-1', T2));
        await repos.quote.save(makeQuote('stk-1', T3));
        const removed = await repos.quote.removeInRange('stk-1', T2);
        expect(removed).toBe(2);
        expect((await repos.quote.latestByStock('stk-1'))?.ts.getTime()).toBe(T3.getTime());
      });
    });

    describe('DailyBarRepository', () => {
      it('saveMany + findInRange 按 date 升序返回', async () => {
        await repos.dailyBar.saveMany([
          makeDailyBar('stk-1', T1),
          makeDailyBar('stk-1', T3),
          makeDailyBar('stk-1', T2),
        ]);
        const got = await repos.dailyBar.findInRange('stk-1', T1, T3);
        expect(got.map((b) => b.date.getTime())).toEqual([
          T1.getTime(),
          T2.getTime(),
          T3.getTime(),
        ]);
      });

      it('findInRange 空区间返回空数组（不抛错）', async () => {
        expect(await repos.dailyBar.findInRange('stk-1', T1, T3)).toEqual([]);
      });

      it('latestBefore 取 ≤ to 的最近 N 根，按 date 升序返回', async () => {
        await repos.dailyBar.saveMany([
          makeDailyBar('stk-1', T1),
          makeDailyBar('stk-1', T2),
          makeDailyBar('stk-1', T3),
        ]);
        const got = await repos.dailyBar.latestBefore('stk-1', T2, 2);
        expect(got.map((b) => b.date.getTime())).toEqual([T1.getTime(), T2.getTime()]);
      });

      it('latestBefore count=0 返回空；count<0 返回空', async () => {
        await repos.dailyBar.saveMany([makeDailyBar('stk-1', T1)]);
        expect(await repos.dailyBar.latestBefore('stk-1', T1, 0)).toEqual([]);
        expect(await repos.dailyBar.latestBefore('stk-1', T1, -1)).toEqual([]);
      });

      it('saveMany 同 (stockId, date) 为 upsert', async () => {
        await repos.dailyBar.saveMany([makeDailyBar('stk-1', T1, { close: money(10) })]);
        await repos.dailyBar.saveMany([makeDailyBar('stk-1', T1, { close: money(99) })]);
        const got = await repos.dailyBar.findInRange('stk-1', T1, T1);
        expect(got[0]?.close).toBe(99);
      });

      it('source 字段往返一致', async () => {
        await repos.dailyBar.saveMany([
          makeDailyBar('stk-1', T1, { source: 'eastmoney' }),
          makeDailyBar('stk-1', T2, { source: 'tencent' }),
        ]);
        const got = await repos.dailyBar.findInRange('stk-1', T1, T2);
        expect(got.map((b) => b.source)).toEqual(['eastmoney', 'tencent']);
      });

      it('只接受 qfq，并让 sourceAdjFactor 往返一致', async () => {
        await repos.dailyBar.saveMany([makeDailyBar('stk-1', T1, { sourceAdjFactor: 1.2345 })]);
        expect((await repos.dailyBar.findInRange('stk-1', T1, T1))[0]?.sourceAdjFactor).toBe(
          1.2345,
        );
        await expect(
          repos.dailyBar.saveMany([
            { ...makeDailyBar('stk-1', T2), adjustment: 'raw' } as unknown as DailyBar,
          ]),
        ).rejects.toThrow();
      });

      it('同批多根 upsert 不互相覆盖；冲突时各日期各自更新（含 source）', async () => {
        await repos.dailyBar.saveMany([
          makeDailyBar('stk-1', T1, { close: money(10), source: 'eastmoney' }),
          makeDailyBar('stk-1', T2, { close: money(20), source: 'eastmoney' }),
        ]);
        // 同批再次 upsert：T1 与 T2 的 OHLCV / source 必须各自落到对应日期
        await repos.dailyBar.saveMany([
          makeDailyBar('stk-1', T1, {
            open: money(11),
            high: money(12),
            low: money(10),
            close: money(11.5),
            volume: 2_000_000,
            source: 'tencent',
          }),
          makeDailyBar('stk-1', T2, {
            open: money(21),
            high: money(22),
            low: money(20),
            close: money(21.5),
            volume: 3_000_000,
            source: 'tencent',
          }),
        ]);
        const got = await repos.dailyBar.findInRange('stk-1', T1, T2);
        expect(got).toHaveLength(2);
        expect(got[0]).toMatchObject({
          close: 11.5,
          open: 11,
          volume: 2_000_000,
          source: 'tencent',
        });
        expect(got[1]).toMatchObject({
          close: 21.5,
          open: 21,
          volume: 3_000_000,
          source: 'tencent',
        });
      });

      it('removeInRange 返回删除条数', async () => {
        await repos.dailyBar.saveMany([
          makeDailyBar('stk-1', T1),
          makeDailyBar('stk-1', T2),
          makeDailyBar('stk-1', T3),
        ]);
        expect(await repos.dailyBar.removeInRange('stk-1', T2)).toBe(2);
        expect(
          (await repos.dailyBar.findInRange('stk-1', T1, T3)).map((b) => b.date.getTime()),
        ).toEqual([T3.getTime()]);
      });

      it('DailyBar revision 按 recordedAt 保留历史版本并支持 PIT 查询', async () => {
        const revision = (
          recordedAt: Date,
          close: number,
          contentHash = `hash-${recordedAt.getTime()}-${close}`,
        ): DailyBarRevision => ({
          stockId: 'stk-1',
          date: T1,
          contentHash,
          open: close - 1,
          high: close + 1,
          low: close - 2,
          close,
          volume: 100,
          source: 'fixture',
          recordedAt,
        });
        await repos.dailyBar.saveRevisions([revision(T2, 10), revision(T3, 11)]);
        await repos.dailyBar.saveRevisions([{ ...revision(T2, 10), recordedAt: T3 }]);
        expect(
          (await repos.dailyBar.listRevisions({ stockId: 'stk-1', recordedAt: T2 })).map(
            (item) => item.close,
          ),
        ).toEqual([10]);
        expect(
          (await repos.dailyBar.listRevisions({ stockId: 'stk-1' })).map((item) => item.close),
        ).toEqual([10, 10, 11]);
      });

      it('DailyBar revision 可按多股票批量 PIT 查询并稳定排序', async () => {
        const revision = (stockId: string, recordedAt: Date, close: number): DailyBarRevision => ({
          stockId,
          date: T1,
          contentHash: `${stockId}-${recordedAt.getTime()}-${close}`,
          open: close - 1,
          high: close + 1,
          low: close - 2,
          close,
          volume: 100,
          source: 'fixture',
          recordedAt,
        });
        await repos.dailyBar.saveRevisions([
          revision('stk-2', T2, 20),
          revision('stk-1', T2, 10),
          revision('stk-1', T3, 11),
        ]);
        const got = await repos.dailyBar.listRevisionsForStocks({
          stockIds: ['stk-2', 'stk-1'],
          recordedAt: T2,
        });
        expect(got.map((item) => `${item.stockId}:${item.close}`)).toEqual([
          'stk-1:10',
          'stk-2:20',
        ]);
      });

      it('DailyBar revision 保留 A → B → A 回退事件', async () => {
        const revision = (
          recordedAt: Date,
          close: number,
          contentHash: string,
        ): DailyBarRevision => ({
          stockId: 'stk-1',
          date: T1,
          contentHash,
          open: close - 1,
          high: close + 1,
          low: close - 2,
          close,
          volume: 100,
          source: 'fixture',
          recordedAt,
        });
        await repos.dailyBar.saveRevisions([
          revision(T1, 10, 'hash-a'),
          revision(T2, 11, 'hash-b'),
          revision(T3, 10, 'hash-a'),
        ]);

        const revisions = await repos.dailyBar.listRevisions({
          stockId: 'stk-1',
          recordedAt: T3,
        });
        expect(revisions.map((item) => [item.recordedAt, item.close])).toEqual([
          [T1, 10],
          [T2, 11],
          [T3, 10],
        ]);
      });
    });

    describe('MinuteBarRepository', () => {
      const M1 = new Date('2026-07-02T01:31:00.000Z');
      const M2 = new Date('2026-07-02T01:32:00.000Z');
      const M3 = new Date('2026-07-03T01:31:00.000Z');

      it('saveMany + findInRange 按 endedAt 升序，字段完整往返', async () => {
        await repos.minuteBar.saveMany([
          makeMinuteBar('stk-1', M2, { amount: 22_000, completeness: 'live' }),
          makeMinuteBar('stk-1', M1),
        ]);
        const got = await repos.minuteBar.findInRange('stk-1', '1m', M1, M2);
        expect(got.map((bar) => bar.endedAt)).toEqual([M1, M2]);
        expect(got[1]).toMatchObject({
          amount: 22_000,
          adjustment: 'raw',
          source: 'tushare',
          completeness: 'live',
        });
      });

      it('同 stock/interval/endedAt upsert；不同 interval 隔离', async () => {
        await repos.minuteBar.saveMany([
          makeMinuteBar('stk-1', M1),
          makeMinuteBar('stk-1', M1, { interval: '5m', high: money(21), close: money(20) }),
        ]);
        await repos.minuteBar.saveMany([
          makeMinuteBar('stk-1', M1, { high: money(13), close: money(12), source: 'replacement' }),
        ]);
        expect((await repos.minuteBar.findInRange('stk-1', '1m', M1, M1))[0]).toMatchObject({
          close: 12,
          source: 'replacement',
        });
        expect((await repos.minuteBar.findInRange('stk-1', '5m', M1, M1))[0]?.close).toBe(20);
      });

      it('latestSession 只返回最新上海交易日', async () => {
        await repos.minuteBar.saveMany([
          makeMinuteBar('stk-1', M1),
          makeMinuteBar('stk-1', M2),
          makeMinuteBar('stk-1', M3),
        ]);
        expect(
          (await repos.minuteBar.latestSession('stk-1', '1m')).map((bar) => bar.endedAt),
        ).toEqual([M3]);
        expect(await repos.minuteBar.latestSession('missing', '1m')).toEqual([]);
      });

      it('removeBefore 按全局保留期删除，不删除边界', async () => {
        await repos.minuteBar.saveMany([
          makeMinuteBar('stk-1', M1),
          makeMinuteBar('stk-2', M2),
          makeMinuteBar('stk-1', M3),
        ]);
        expect(await repos.minuteBar.removeBefore(M2)).toBe(1);
        expect(await repos.minuteBar.findInRange('stk-2', '1m', M2, M2)).toHaveLength(1);
        expect(await repos.minuteBar.findInRange('stk-1', '1m', M1, M3)).toHaveLength(1);
      });

      it('拒绝 qfq MinuteBar，防止与 DailyBar 口径混用', async () => {
        await expect(
          repos.minuteBar.saveMany([
            { ...makeMinuteBar('stk-1', M1), adjustment: 'qfq' } as unknown as MinuteBar,
          ]),
        ).rejects.toThrow();
      });
    });

    describe('StrategyRepository', () => {
      it('Strategy 与版本往返、过滤和版本排序一致', async () => {
        await repos.strategy.create(makeStrategy('strategy-2', { owner: 'builtin' }));
        await repos.strategy.create(makeStrategy('strategy-1'));
        await repos.strategy.createVersion(makeStrategyVersion('strategy-1', 1));
        await repos.strategy.createVersion(makeStrategyVersion('strategy-1', 2));
        expect(await repos.strategy.findById('strategy-1')).toEqual(makeStrategy('strategy-1'));
        expect((await repos.strategy.list()).map((strategy) => strategy.id)).toEqual([
          'strategy-1',
          'strategy-2',
        ]);
        expect(
          (await repos.strategy.list({ owner: 'builtin' })).map((strategy) => strategy.id),
        ).toEqual(['strategy-2']);
        expect(
          (await repos.strategy.listVersions('strategy-1')).map((version) => version.version),
        ).toEqual([1, 2]);
      });

      it('旧 StrategyVersion 的重复 scoring component 仍可存取', async () => {
        await repos.strategy.create(makeStrategy('strategy-1'));
        const base = makeStrategyVersion('strategy-1');
        const definition = {
          ...base.definition,
          scoring: {
            method: 'weighted-sum' as const,
            components: [
              { ruleId: 'rule-1', score: '50', weight: 0.5 },
              { ruleId: 'rule-1', score: '60', weight: 0.5 },
            ],
          },
        };
        const legacyVersion: StrategyVersion = {
          ...base,
          definition,
          definitionHash: strategyDefinitionHash(definition),
        };

        await repos.strategy.createVersion(legacyVersion);

        expect(await repos.strategy.findVersionById(legacyVersion.id)).toEqual(legacyVersion);
      });

      it('activateVersion 只接受同 Strategy 的 published valid version', async () => {
        await repos.strategy.create(makeStrategy('strategy-1'));
        const version = makeStrategyVersion('strategy-1');
        await repos.strategy.createVersion(version);
        await repos.strategy.activateVersion('strategy-1', version.id, T2);
        expect(await repos.strategy.findById('strategy-1')).toEqual(
          makeStrategy('strategy-1', {
            status: 'active',
            currentVersionId: version.id,
            updatedAt: T2,
          }),
        );

        await repos.strategy.create(makeStrategy('strategy-2'));
        await expect(repos.strategy.activateVersion('strategy-2', version.id, T2)).rejects.toThrow(
          InvariantError,
        );
      });

      it('publishVersion 原子发布 valid version 并切换 currentVersion', async () => {
        await repos.strategy.create(makeStrategy('strategy-1'));
        const publishedFixture = makeStrategyVersion('strategy-1');
        const { publishedAt: _publishedAt, ...draftVersion } = publishedFixture;
        await repos.strategy.createVersion(draftVersion);
        await repos.strategy.publishVersion('strategy-1', draftVersion.id, T2);
        expect(await repos.strategy.findVersionById(draftVersion.id)).toMatchObject({
          publishedAt: T2,
        });
        expect(await repos.strategy.findById('strategy-1')).toMatchObject({
          status: 'active',
          currentVersionId: draftVersion.id,
          updatedAt: T2,
        });
      });

      it('StrategyVersion 定义只追加；校验只更新 validation 字段', async () => {
        await repos.strategy.create(makeStrategy('strategy-1'));
        const publishedFixture = makeStrategyVersion('strategy-1');
        const { publishedAt: _publishedAt, ...version } = publishedFixture;
        await repos.strategy.createVersion(version);
        await repos.strategy.setVersionValidation(version.id, {
          status: 'invalid',
          errors: ['bad'],
        });
        expect(await repos.strategy.findVersionById(version.id)).toEqual({
          ...version,
          validationStatus: 'invalid',
          validationErrors: ['bad'],
        });
        const changedDefinition = {
          ...version.definition,
          metadata: { style: 'changed' },
        };
        await expect(
          repos.strategy.createVersion({
            ...version,
            definition: changedDefinition,
            definitionHash: strategyDefinitionHash(changedDefinition),
          }),
        ).rejects.toThrow(InvariantError);
        await expect(
          repos.strategy.createVersion({
            ...makeStrategyVersion('strategy-1'),
            id: 'another-id',
          }),
        ).rejects.toThrow(InvariantError);
      });

      it('pause/resume 只允许 active ↔ paused 用户 Strategy', async () => {
        await repos.strategy.create(makeStrategy('strategy-1'));
        await expect(repos.strategy.pause('strategy-1', T1)).rejects.toThrow(InvariantError);
        const version = makeStrategyVersion('strategy-1');
        await repos.strategy.createVersion(version);
        await repos.strategy.activateVersion('strategy-1', version.id, T1);
        await repos.strategy.pause('strategy-1', T2);
        expect(await repos.strategy.findById('strategy-1')).toMatchObject({ status: 'paused' });
        await repos.strategy.resume('strategy-1', T3);
        expect(await repos.strategy.findById('strategy-1')).toMatchObject({
          status: 'active',
          updatedAt: T3,
        });
      });

      it('archive 只允许 paused 的用户 Strategy，归档为终态（M2 §9.1）', async () => {
        await repos.strategy.create(makeStrategy('strategy-1'));
        // draft 不可归档
        await expect(repos.strategy.archive('strategy-1', T1)).rejects.toThrow(InvariantError);
        const version = makeStrategyVersion('strategy-1');
        await repos.strategy.createVersion(version);
        await repos.strategy.activateVersion('strategy-1', version.id, T1);
        // active 不可归档
        await expect(repos.strategy.archive('strategy-1', T2)).rejects.toThrow(InvariantError);
        await repos.strategy.pause('strategy-1', T2);
        await repos.strategy.archive('strategy-1', T3);
        expect(await repos.strategy.findById('strategy-1')).toMatchObject({
          status: 'archived',
          updatedAt: T3,
        });
        // archived 是终态：不可再次归档、不可恢复
        await expect(repos.strategy.archive('strategy-1', T3)).rejects.toThrow(InvariantError);
        await expect(repos.strategy.resume('strategy-1', T3)).rejects.toThrow(InvariantError);
        // builtin 不可归档；不存在的 id 拒绝
        await repos.strategy.create(
          makeStrategy('strategy-builtin', { owner: 'builtin', status: 'paused' }),
        );
        await expect(repos.strategy.archive('strategy-builtin', T3)).rejects.toThrow(
          InvariantError,
        );
        await expect(repos.strategy.archive('missing', T3)).rejects.toThrow(InvariantError);
      });

      it('remove 删除 Strategy 身份与全部版本', async () => {
        await repos.strategy.create(makeStrategy('strategy-remove'));
        await repos.strategy.createVersion(makeStrategyVersion('strategy-remove'));
        await repos.strategy.remove('strategy-remove');
        expect(await repos.strategy.findById('strategy-remove')).toBeNull();
        expect(await repos.strategy.listVersions('strategy-remove')).toEqual([]);
      });
    });

    describe('StrategyRunRepository', () => {
      beforeEach(async () => {
        await repos.strategy.create(makeStrategy('strategy-1'));
        await repos.strategy.createVersion(makeStrategyVersion('strategy-1'));
        await repos.strategy.activateVersion('strategy-1', 'strategy-1-v1', T1);
      });

      it('run 往返和过滤排序一致', async () => {
        await repos.strategyRun.commitRun({
          run: makeStrategyRun('run-1', { startedAt: T1, finishedAt: T2 }),
          results: [],
          signals: [],
        });
        await repos.strategyRun.commitRun({
          run: makeStrategyRun('run-2', { startedAt: T2, finishedAt: T3 }),
          results: [],
          signals: [],
        });
        expect(await repos.strategyRun.findRunById('run-1')).toEqual(
          makeStrategyRun('run-1', { startedAt: T1, finishedAt: T2 }),
        );
        expect(
          (await repos.strategyRun.listRuns({ strategyId: 'strategy-1' })).map((run) => run.id),
        ).toEqual(['run-2', 'run-1']);
        expect(
          (await repos.strategyRun.listRuns({ strategyId: 'strategy-1', limit: 1 })).map(
            (run) => run.id,
          ),
        ).toEqual(['run-2']);
        await repos.strategyRun.commitRun({
          run: makeStrategyRun('run-3', {
            startedAt: T3,
            finishedAt: new Date(T3.getTime() + 60_000),
          }),
          results: [],
          signals: [],
        });
        expect(
          (
            await repos.strategyRun.listRuns({
              strategyId: 'strategy-1',
              since: T1,
              until: T2,
              limit: 1,
            })
          ).map((run) => run.id),
        ).toEqual(['run-2']);
      });

      it('saveStartedRun 立即可见，commitRun 原子更新为终态', async () => {
        const running = makeStrategyRun('run-visible', {
          status: 'running',
          finishedAt: undefined,
          summary: undefined,
        });
        await repos.strategyRun.saveStartedRun(running);
        expect(await repos.strategyRun.findRunById(running.id)).toEqual(running);
        expect((await repos.strategyRun.listRuns({ status: 'running' }))[0]?.id).toBe(running.id);

        const complete = makeStrategyRun(running.id, { startedAt: running.startedAt });
        await repos.strategyRun.commitRun({ run: complete, results: [], signals: [] });
        expect(await repos.strategyRun.findRunById(running.id)).toEqual(complete);
        expect(await repos.strategyRun.listRuns({ status: 'running' })).toEqual([]);
      });

      it('运行开始后 Strategy 被暂停，仍可提交 complete / failed 终态', async () => {
        const completeRunning = makeStrategyRun('run-paused-complete', {
          status: 'running',
          finishedAt: undefined,
          summary: undefined,
        });
        await repos.strategyRun.saveStartedRun(completeRunning);
        await repos.strategy.pause('strategy-1', T2);
        const complete = makeStrategyRun(completeRunning.id, {
          startedAt: completeRunning.startedAt,
        });
        await repos.strategyRun.commitRun({ run: complete, results: [], signals: [] });
        expect(await repos.strategyRun.findRunById(complete.id)).toEqual(complete);

        await repos.strategy.resume('strategy-1', T3);
        const failedRunning = makeStrategyRun('run-paused-failed', {
          status: 'running',
          finishedAt: undefined,
          summary: undefined,
          startedAt: T3,
          dataAsOf: T3,
        });
        await repos.strategyRun.saveStartedRun(failedRunning);
        await repos.strategy.pause('strategy-1', FAR_FUTURE);
        const failed = makeStrategyRun(failedRunning.id, {
          status: 'failed',
          error: 'provider failed',
          summary: undefined,
          startedAt: failedRunning.startedAt,
          dataAsOf: failedRunning.dataAsOf,
          finishedAt: FAR_FUTURE,
        });
        await repos.strategyRun.commitRun({ run: failed, results: [], signals: [] });
        expect(await repos.strategyRun.findRunById(failed.id)).toEqual(failed);
      });

      it('active Strategy 可运行显式 pinned 的历史 published valid version', async () => {
        const version2 = makeStrategyVersion('strategy-1', 2, {
          id: 'strategy-1-v2',
          createdAt: T2,
          publishedAt: T2,
        });
        await repos.strategy.createVersion(version2);
        await repos.strategy.activateVersion('strategy-1', version2.id, T2);
        const pinned = makeStrategyRun('run-pinned-v1', {
          strategyVersionId: 'strategy-1-v1',
        });
        await repos.strategyRun.commitRun({ run: pinned, results: [], signals: [] });
        expect(await repos.strategyRun.findRunById(pinned.id)).toEqual(pinned);
      });

      it('evaluation scope 的持久化 run 可绑定未发布 valid version，operational scope 仍拒绝', async () => {
        const draft = makeStrategyVersion('strategy-1', 2, {
          id: 'strategy-1-v2-draft',
          createdAt: T2,
          publishedAt: undefined,
        });
        await repos.strategy.createVersion(draft);

        // evaluation run 是非发布验证证据（publication=non-publishing），允许未发布候选版本。
        const evaluationRun = makeStrategyRun('run-draft-evaluation', {
          strategyVersionId: draft.id,
          scope: 'evaluation',
          publication: {
            status: 'non-publishing',
            reasons: ['evaluation-scope'],
            decidedAt: T2,
          },
        });
        await repos.strategyRun.commitRun({ run: evaluationRun, results: [], signals: [] });
        expect(await repos.strategyRun.findRunById(evaluationRun.id)).toEqual(evaluationRun);

        const startedEvaluation = makeStrategyRun('run-draft-evaluation-started', {
          strategyVersionId: draft.id,
          scope: 'evaluation',
          status: 'running',
          finishedAt: undefined,
          summary: undefined,
        });
        await repos.strategyRun.saveStartedRun(startedEvaluation);
        expect(await repos.strategyRun.findRunById(startedEvaluation.id)).toEqual(
          startedEvaluation,
        );

        // operational run 仍只接受 published 版本（生产股票池保护不变）。
        const operationalRun = makeStrategyRun('run-draft-operational', {
          strategyVersionId: draft.id,
          scope: 'operational',
        });
        await expect(
          repos.strategyRun.commitRun({ run: operationalRun, results: [], signals: [] }),
        ).rejects.toThrow('StrategyRun 必须绑定 active Strategy 的 published valid version');
        const startedOperational = makeStrategyRun('run-draft-operational-started', {
          strategyVersionId: draft.id,
          scope: 'operational',
          status: 'running',
          finishedAt: undefined,
          summary: undefined,
        });
        await expect(repos.strategyRun.saveStartedRun(startedOperational)).rejects.toThrow(
          'StrategyRun 必须绑定 active Strategy 的 published valid version',
        );
      });

      it('draft Strategy 只允许 evaluation scope 的持久化 run（M2 §9.2 新策略首发验证）', async () => {
        await repos.strategy.create(makeStrategy('strategy-new'));
        const version = makeStrategyVersion('strategy-new', 1, {
          id: 'strategy-new-v1',
          publishedAt: undefined,
        });
        await repos.strategy.createVersion(version);

        // 新策略首发前的独立验证：draft + evaluation scope 允许（非发布验证证据）。
        const evaluationRun = makeStrategyRun('run-new-evaluation', {
          strategyId: 'strategy-new',
          strategyVersionId: version.id,
          scope: 'evaluation',
          publication: {
            status: 'non-publishing',
            reasons: ['evaluation-scope'],
            decidedAt: T2,
          },
        });
        await repos.strategyRun.commitRun({ run: evaluationRun, results: [], signals: [] });
        expect(await repos.strategyRun.findRunById(evaluationRun.id)).toEqual(evaluationRun);

        const startedEvaluation = makeStrategyRun('run-new-evaluation-started', {
          strategyId: 'strategy-new',
          strategyVersionId: version.id,
          scope: 'evaluation',
          status: 'running',
          finishedAt: undefined,
          summary: undefined,
        });
        await repos.strategyRun.saveStartedRun(startedEvaluation);
        expect(await repos.strategyRun.findRunById(startedEvaluation.id)).toEqual(
          startedEvaluation,
        );

        // operational run 仍拒绝 draft Strategy（生产信号保护不变）。
        const operationalRun = makeStrategyRun('run-new-operational', {
          strategyId: 'strategy-new',
          strategyVersionId: version.id,
          scope: 'operational',
        });
        await expect(
          repos.strategyRun.commitRun({ run: operationalRun, results: [], signals: [] }),
        ).rejects.toThrow('StrategyRun 必须绑定 active Strategy 的 published valid version');
      });

      it('commitRun 原子写入后 results 按 rank/stock 排序', async () => {
        await repos.strategyRun.commitRun({
          run: makeStrategyRun('run-1'),
          results: [
            makeStrategyResult('run-1', '600519.SH', { rank: 2, score: 90 }),
            makeStrategyResult('run-1', '002594.SZ', { rank: 1 }),
          ],
          signals: [],
        });
        const results = await repos.strategyRun.listResults('run-1');
        expect(results.map((result) => result.stockId)).toEqual(['002594.SZ', '600519.SH']);
        expect(results[1]?.score).toBe(90);
      });

      it('commitRun round-trip 保留可选 scoring breakdown', async () => {
        const scoringBreakdown: NonNullable<StrategyResult['scoringBreakdown']> = [
          {
            schemaVersion: 1,
            ruleId: 'rule-1',
            expression: 'indicators.rsi14',
            status: 'available',
            inputs: [{ path: 'indicators.rsi14', status: 'available', value: 80 }],
            weight: 0.5,
            rawScore: 80,
            contribution: 40,
          },
        ];
        const original = makeStrategyResult('run-1', '600519.SH', { scoringBreakdown });
        await repos.strategyRun.commitRun({
          run: makeStrategyRun('run-1'),
          results: [original],
          signals: [],
        });

        expect(await repos.strategyRun.listResults('run-1')).toEqual([original]);
      });

      it('listResults 无 rank 的结果排在最后', async () => {
        await repos.strategyRun.commitRun({
          run: makeStrategyRun('run-1'),
          results: [
            makeStrategyResult('run-1', '600519.SH', { rank: undefined }),
            makeStrategyResult('run-1', '002594.SZ', { rank: 1 }),
          ],
          signals: [],
        });
        const results = await repos.strategyRun.listResults('run-1');
        expect(results.map((result) => result.stockId)).toEqual(['002594.SZ', '600519.SH']);
        expect(results[1]?.rank).toBeUndefined();
      });

      it('signals 以 run/rule/stock/ts 唯一，跨运行同一时点和同运行不同时点都能保存', async () => {
        const first = makeStrategySignal('signal-1', '600519.SH', { runId: 'run-1', ts: T1 });
        const second = makeStrategySignal('signal-2', '600519.SH', {
          runId: 'run-2',
          ts: T1,
        });
        const laterInSameRun = makeStrategySignal('signal-3', '600519.SH', {
          runId: 'run-1',
          ts: T2,
        });
        await repos.strategyRun.commitRun({
          run: makeStrategyRun('run-1', { startedAt: T1, finishedAt: T2 }),
          results: [],
          signals: [first, laterInSameRun],
        });
        await repos.strategyRun.commitRun({
          run: makeStrategyRun('run-2', { startedAt: T1, finishedAt: T2 }),
          results: [],
          signals: [second],
        });
        expect(
          (await repos.strategyRun.signalsByStrategy('strategy-1')).map((signal) => signal.id),
        ).toEqual(['signal-3', 'signal-2', 'signal-1']);
        expect(
          (await repos.strategyRun.signalsByStock('600519.SH')).map((item) => item.id),
        ).toEqual(['signal-3', 'signal-2', 'signal-1']);
      });

      it('signalsByRun 只返回指定运行并保持时间倒序', async () => {
        const older = makeStrategySignal('signal-old', '600519.SH', { runId: 'run-1', ts: T1 });
        const newer = makeStrategySignal('signal-new', '002594.SZ', { runId: 'run-1', ts: T2 });
        const otherRun = makeStrategySignal('signal-other', '300750.SZ', {
          runId: 'run-2',
          ts: T3,
        });
        await repos.strategyRun.commitRun({
          run: makeStrategyRun('run-1', { startedAt: T1 }),
          results: [],
          signals: [older, newer],
        });
        await repos.strategyRun.commitRun({
          run: makeStrategyRun('run-2', { startedAt: T2, finishedAt: T3 }),
          results: [],
          signals: [otherRun],
        });

        expect((await repos.strategyRun.signalsByRun('run-1')).map((signal) => signal.id)).toEqual([
          'signal-new',
          'signal-old',
        ]);
        expect(await repos.strategyRun.signalsByRun('missing')).toEqual([]);
      });

      it('批量读取 results/signals 与按 id 读取保持完整且稳定排序', async () => {
        await repos.strategyRun.commitRun({
          run: makeStrategyRun('run-bulk-a', { startedAt: T1 }),
          results: [
            makeStrategyResult('run-bulk-a', '600519.SH', { rank: 2 }),
            makeStrategyResult('run-bulk-a', '002594.SZ', { rank: 1 }),
          ],
          signals: [
            makeStrategySignal('signal-bulk-a', '600519.SH', {
              runId: 'run-bulk-a',
              ts: T1,
            }),
          ],
        });
        await repos.strategyRun.commitRun({
          run: makeStrategyRun('run-bulk-b', { startedAt: T2 }),
          results: [makeStrategyResult('run-bulk-b', '300750.SZ', { rank: 1 })],
          signals: [
            makeStrategySignal('signal-bulk-b', '300750.SZ', {
              runId: 'run-bulk-b',
              ts: T3,
            }),
          ],
        });

        expect(
          (await repos.strategyRun.listResultsByRuns(['run-bulk-b', 'run-bulk-a'])).map(
            (result) => `${result.runId}:${result.stockId}`,
          ),
        ).toEqual(['run-bulk-a:002594.SZ', 'run-bulk-a:600519.SH', 'run-bulk-b:300750.SZ']);
        expect(
          (await repos.strategyRun.signalsByRuns(['run-bulk-a', 'run-bulk-b'])).map(
            (signal) => signal.id,
          ),
        ).toEqual(['signal-bulk-b', 'signal-bulk-a']);
        expect(await repos.strategyRun.signalsByIds(['signal-bulk-a', 'missing'])).toEqual([
          expect.objectContaining({ id: 'signal-bulk-a' }),
        ]);
        expect(await repos.strategyRun.signalsByRuns([])).toEqual([]);
      });

      it('commitRun 原子提交；引用不匹配时不留下 run/result/signal', async () => {
        const run = makeStrategyRun('run-atomic');
        await repos.strategyRun.commitRun({
          run,
          results: [makeStrategyResult(run.id, '600519.SH')],
          signals: [
            makeStrategySignal('signal-atomic', '600519.SH', {
              runId: run.id,
              strategyId: run.strategyId,
              strategyVersionId: run.strategyVersionId,
            }),
          ],
        });
        expect(await repos.strategyRun.findRunById(run.id)).toEqual(run);
        expect(await repos.strategyRun.listResults(run.id)).toHaveLength(1);

        const invalidRun = makeStrategyRun('run-invalid');
        await expect(
          repos.strategyRun.commitRun({
            run: invalidRun,
            results: [makeStrategyResult('another-run', '002594.SZ')],
            signals: [],
          }),
        ).rejects.toThrow(InvariantError);
        expect(await repos.strategyRun.findRunById(invalidRun.id)).toBeNull();
        expect(await repos.strategyRun.listResults(invalidRun.id)).toEqual([]);
      });

      it('commitRun 是 append-only；重复 runId 或包内重复事实不会覆盖已有运行', async () => {
        const run = makeStrategyRun('run-append-only');
        const original = makeStrategyResult(run.id, '600519.SH', { score: 80 });
        await repos.strategyRun.commitRun({ run, results: [original], signals: [] });

        await expect(
          repos.strategyRun.commitRun({
            run: { ...run, dataAsOf: T3 },
            results: [makeStrategyResult(run.id, '600519.SH', { score: 99 })],
            signals: [],
          }),
        ).rejects.toThrow();
        expect(await repos.strategyRun.findRunById(run.id)).toEqual(run);
        expect(await repos.strategyRun.listResults(run.id)).toEqual([original]);

        const invalidRun = makeStrategyRun('run-duplicate-facts');
        await expect(
          repos.strategyRun.commitRun({
            run: invalidRun,
            results: [
              makeStrategyResult(invalidRun.id, '600519.SH'),
              makeStrategyResult(invalidRun.id, '600519.SH'),
            ],
            signals: [],
          }),
        ).rejects.toThrow(InvariantError);
        expect(await repos.strategyRun.findRunById(invalidRun.id)).toBeNull();
      });

      it('removeByStrategyId 删除运行、结果、信号', async () => {
        const run = makeStrategyRun('run-remove');
        await repos.strategyRun.commitRun({
          run,
          results: [makeStrategyResult(run.id, '600519.SH')],
          signals: [makeStrategySignal('signal-remove', '600519.SH', { runId: run.id })],
        });
        await repos.strategyRun.removeByStrategyId('strategy-1');
        expect(await repos.strategyRun.findRunById(run.id)).toBeNull();
        expect(await repos.strategyRun.listResults(run.id)).toEqual([]);
        expect(await repos.strategyRun.signalsByStrategy('strategy-1')).toEqual([]);
      });
    });

    describe('StrategyWatchlistSubscriptionRepository', () => {
      it('save/find/list 往返一致并按 status 过滤', async () => {
        const subscription = makeStrategyWatchlistSubscription('subscription-1');
        await repos.strategyWatchlistSubscription.save(subscription);
        expect(await repos.strategyWatchlistSubscription.findById(subscription.id)).toEqual(
          subscription,
        );
        expect(
          await repos.strategyWatchlistSubscription.findActive({
            strategyId: subscription.strategyId,
            watchlistId: subscription.watchlistId,
          }),
        ).toEqual(subscription);
        expect(await repos.strategyWatchlistSubscription.list({ status: 'active' })).toEqual([
          subscription,
        ]);
      });

      it('同一 Strategy/Watchlist 只允许一个 active，取消后可重新订阅', async () => {
        const first = makeStrategyWatchlistSubscription('subscription-1');
        await repos.strategyWatchlistSubscription.save(first);
        await expect(
          repos.strategyWatchlistSubscription.save(
            makeStrategyWatchlistSubscription('subscription-2'),
          ),
        ).rejects.toThrow(InvariantError);
        const cancelled = makeStrategyWatchlistSubscription('subscription-1', {
          status: 'cancelled',
          updatedAt: T2,
          cancelledAt: T2,
          cancelledBy: 'user-2',
        });
        await repos.strategyWatchlistSubscription.save(cancelled);
        const second = makeStrategyWatchlistSubscription('subscription-2', {
          createdAt: T3,
          updatedAt: T3,
        });
        await repos.strategyWatchlistSubscription.save(second);
        expect((await repos.strategyWatchlistSubscription.list({})).map((item) => item.id)).toEqual(
          ['subscription-2', 'subscription-1'],
        );
        expect(
          await repos.strategyWatchlistSubscription.findActive({
            strategyId: first.strategyId,
            watchlistId: first.watchlistId,
          }),
        ).toEqual(second);
      });

      it('sourceKey 与取消字段违反不变量时拒绝', async () => {
        await expect(
          repos.strategyWatchlistSubscription.save(
            makeStrategyWatchlistSubscription('bad-source', {
              sourceKey: 'strategy:other',
            }),
          ),
        ).rejects.toThrow(InvariantError);
        await expect(
          repos.strategyWatchlistSubscription.save(
            makeStrategyWatchlistSubscription('bad-cancel', {
              status: 'cancelled',
              updatedAt: T2,
            }),
          ),
        ).rejects.toThrow(InvariantError);
      });
    });

    describe('SignalObservationRepository', () => {
      it('listBySources 不受通用 list 默认 limit 影响并按来源/周期过滤', async () => {
        const rows = Array.from({ length: 1_005 }, (_, index) =>
          makeSignalObservation(`bulk-observation-${index}`, `bulk-signal-${index}`),
        );
        for (const row of rows) await repos.signalObservation.save(row);
        await repos.signalObservation.save(
          makeSignalObservation('bulk-t20', 'bulk-signal-0', { horizon: 't20' }),
        );
        await repos.signalObservation.save(
          makeSignalObservation('bulk-watch', 'bulk-signal-1', { sourceKind: 'watch-trigger' }),
        );

        const listed = await repos.signalObservation.listBySources({
          sourceKind: 'strategy-signal',
          sourceIds: rows.map((row) => row.sourceId),
          horizons: ['t1'],
        });
        expect(listed).toHaveLength(rows.length);
        expect(listed.some((row) => row.id === 'bulk-t20')).toBe(false);
        expect(listed.some((row) => row.id === 'bulk-watch')).toBe(false);
      });

      it('removeBySources 只删除指定来源的观察', async () => {
        await repos.signalObservation.save(makeSignalObservation('observation-1', 'signal-1'));
        await repos.signalObservation.save(makeSignalObservation('observation-2', 'signal-2'));
        await repos.signalObservation.removeBySources('strategy-signal', ['signal-1']);
        expect(await repos.signalObservation.findById('observation-1')).toBeNull();
        expect(await repos.signalObservation.findById('observation-2')).not.toBeNull();
      });
    });

    describe('Watchlist repositories', () => {
      beforeEach(async () => {
        await repos.watchlist.save(makeWatchlist('watchlist-1'));
      });

      it('Watchlist 往返、过滤与 archive 一致', async () => {
        await repos.watchlist.save(
          makeWatchlist('portfolio-1', {
            kind: 'portfolio',
            membershipPolicy: 'synced',
          }),
        );
        expect((await repos.watchlist.list({ enabledOnly: true })).map((item) => item.id)).toEqual([
          'portfolio-1',
          'watchlist-1',
        ]);
        expect((await repos.watchlist.list({ kind: 'portfolio' })).map((item) => item.id)).toEqual([
          'portfolio-1',
        ]);
        await repos.watchlist.archive('watchlist-1', T2);
        expect(await repos.watchlist.findById('watchlist-1')).toMatchObject({
          enabled: false,
          updatedAt: T2,
        });
      });

      it('complete sync 支持 entered/unchanged/exited，多来源不会互相删除', async () => {
        const first = await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-1'),
          candidates: [
            { stockId: '600519.SH', reason: 'first', score: 90, evidence: ['a'] },
            { stockId: '002594.SZ', reason: 'first', score: 80, evidence: ['b'] },
          ],
          sourceId: 'strategy-1',
          sourceVersionId: 'strategy-1-v1',
        });
        expect(first).toMatchObject({ enteredCount: 2, exitedCount: 0, unchangedCount: 0 });
        const member = await repos.watchlistMember.findMember('watchlist-1', '600519.SH');
        if (member === null) throw new Error('fixture member missing');
        await repos.watchlistMember.saveMember({
          ...member,
          stage: 'watching',
          lastActivityAt: T2,
        });
        const manual: WatchlistMemberSource = {
          id: 'manual-source',
          memberId: member.id,
          kind: 'manual',
          sourceKey: `manual:${member.id}`,
          reason: '用户保留',
          status: 'active',
          evidence: [],
          validFrom: T2,
        };
        await repos.watchlistMember.saveSource(manual);

        const second = await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-2', { startedAt: T2, finishedAt: T3, dataAsOf: T2 }),
          candidates: [
            { stockId: '002594.SZ', reason: 'again', score: 82, evidence: ['b2'] },
            { stockId: '000001.SZ', reason: 'new', score: 70, evidence: ['c'] },
          ],
          sourceId: 'strategy-1',
        });
        expect(second).toMatchObject({ enteredCount: 1, exitedCount: 1, unchangedCount: 1 });
        // §6：snapshot 表已删；变更明细由 workflow_runs.outputSummary.changes 还原。
        expect(
          (await repos.watchlistMember.listSnapshots('sync-2')).map((item) => [
            item.stockId,
            item.change,
          ]),
        ).toEqual([
          ['000001.SZ', 'entered'],
          ['002594.SZ', 'unchanged'],
          ['600519.SH', 'exited'],
        ]);
        expect(await repos.watchlistMember.findMember('watchlist-1', '600519.SH')).toMatchObject({
          stage: 'watching',
        });
        expect(await repos.watchlistMember.listSources(member.id)).toEqual([manual]);
        expect(await repos.watchlistMember.listSources(member.id, true)).toHaveLength(2);
      });

      it('同一 producerRun 重试幂等，不重复创建 sync run 或结束来源', async () => {
        const producerRunId = 'strategy-run-idempotent';
        const first = await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-idempotent-1', { producerRunId }),
          candidates: [{ stockId: '600519.SH', reason: 'first', evidence: ['e1'] }],
        });
        const retry = await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-idempotent-2', {
            producerRunId,
            startedAt: T2,
            finishedAt: T3,
          }),
          candidates: [{ stockId: '002594.SZ', reason: 'must-not-apply', evidence: ['e2'] }],
        });
        expect(retry).toEqual(first);
        expect(await repos.watchlistMember.listSyncRuns('watchlist-1')).toHaveLength(1);
        expect(await repos.watchlistMember.listSnapshots(first.id)).toHaveLength(1);
        const member = await repos.watchlistMember.findMember('watchlist-1', '600519.SH');
        if (member === null) throw new Error('fixture member missing');
        expect(
          await repos.watchlistMember.currentSource(member.id, 'strategy:strategy-1'),
        ).toMatchObject({ status: 'active', syncRunId: first.id });
      });

      it('partial/failed 不退出来源；complete 空结果才结束并归档自动成员', async () => {
        await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-1'),
          candidates: [{ stockId: '600519.SH', reason: 'first', evidence: [] }],
        });
        const partial = await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-partial', {
            status: 'partial',
            startedAt: T2,
            finishedAt: T3,
          }),
          candidates: [],
        });
        expect(partial.exitedCount).toBe(0);
        const member = await repos.watchlistMember.findMember('watchlist-1', '600519.SH');
        if (member === null) throw new Error('fixture member missing');
        expect(
          await repos.watchlistMember.currentSource(member.id, 'strategy:strategy-1'),
        ).toMatchObject({ status: 'stale' });

        const complete = await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-empty', {
            startedAt: T3,
            finishedAt: new Date(T3.getTime() + 1),
          }),
          candidates: [],
        });
        expect(complete.exitedCount).toBe(1);
        expect(await repos.watchlistMember.findMember('watchlist-1', '600519.SH')).toMatchObject({
          stage: 'archived',
        });
      });

      it('ended 后重新进入创建新来源并 revive；非法 bundle 原子回滚', async () => {
        await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-1'),
          candidates: [{ stockId: '600519.SH', reason: 'first', evidence: [] }],
        });
        await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-2', { startedAt: T2, finishedAt: T3 }),
          candidates: [],
        });
        await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-3', {
            startedAt: T3,
            finishedAt: new Date(T3.getTime() + 1),
          }),
          candidates: [{ stockId: '600519.SH', reason: 'return', evidence: [] }],
        });
        const member = await repos.watchlistMember.findMember('watchlist-1', '600519.SH');
        if (member === null) throw new Error('fixture member missing');
        expect(member.stage).toBe('discovered');
        expect(await repos.watchlistMember.listSources(member.id, true)).toHaveLength(2);

        await expect(
          repos.watchlistMember.commitWatchlistSync({
            run: makeWatchlistSyncRun('sync-invalid'),
            candidates: [
              { stockId: '002594.SZ', reason: 'duplicate', evidence: [] },
              { stockId: '002594.SZ', reason: 'duplicate', evidence: [] },
            ],
          }),
        ).rejects.toThrow(InvariantError);
        expect(await repos.watchlistMember.listSyncRuns('watchlist-1')).not.toContainEqual(
          expect.objectContaining({ id: 'sync-invalid' }),
        );
      });

      it('saveSyncRun 要求 Watchlist 存在', async () => {
        await expect(
          repos.watchlistMember.saveSyncRun(
            makeWatchlistSyncRun('sync-orphan', { watchlistId: 'missing-watchlist' }),
          ),
        ).rejects.toThrow(InvariantError);
      });

      it('saveMember 重复 (watchlistId, stockId) 不同 id 拒绝', async () => {
        await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-1'),
          candidates: [{ stockId: '600519.SH', reason: 'first', evidence: [] }],
        });
        const member = await repos.watchlistMember.findMember('watchlist-1', '600519.SH');
        if (member === null) throw new Error('fixture member missing');
        await expect(
          repos.watchlistMember.saveMember({ ...member, id: 'another-member-id' }),
        ).rejects.toThrow(InvariantError);
      });

      it('saveSource 同 (memberId, sourceKey) 只允许一个非 ended 来源', async () => {
        await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-1'),
          candidates: [{ stockId: '600519.SH', reason: 'first', evidence: [] }],
        });
        const member = await repos.watchlistMember.findMember('watchlist-1', '600519.SH');
        if (member === null) throw new Error('fixture member missing');
        const current = await repos.watchlistMember.currentSource(member.id, 'strategy:strategy-1');
        if (current === null) throw new Error('fixture source missing');
        await expect(
          repos.watchlistMember.saveSource({
            ...current,
            id: 'duplicate-source',
            validFrom: T3,
          }),
        ).rejects.toThrow(InvariantError);
        // ended 来源不占唯一约束，可以再写一条 active。
        await repos.watchlistMember.saveSource({ ...current, status: 'ended', validUntil: T3 });
        await repos.watchlistMember.saveSource({
          ...current,
          id: 'successor-source',
          validFrom: T3,
        });
        expect(await repos.watchlistMember.listSources(member.id)).toHaveLength(1);
      });

      it('unchanged 候选缺省 score/rank/dataAsOf 时保留旧值', async () => {
        await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-1'),
          candidates: [
            {
              stockId: '600519.SH',
              reason: 'first',
              score: 90,
              rank: 1,
              evidence: [],
              dataAsOf: T1,
            },
          ],
        });
        await repos.watchlistMember.commitWatchlistSync({
          run: makeWatchlistSyncRun('sync-2', { startedAt: T2, finishedAt: T3 }),
          candidates: [{ stockId: '600519.SH', reason: 'again', evidence: [] }],
        });
        const member = await repos.watchlistMember.findMember('watchlist-1', '600519.SH');
        if (member === null) throw new Error('fixture member missing');
        expect(
          await repos.watchlistMember.currentSource(member.id, 'strategy:strategy-1'),
        ).toMatchObject({ score: 90, rank: 1, dataAsOf: T1 });
      });
    });

    describe('NotificationRepository', () => {
      it('固定通知身份失败后重试，更新正文与最近尝试时间', async () => {
        await repos.notification.save(
          makeNotification('report-notification:report-1', {
            channel: 'feishu',
            result: 'failed',
            errorMessage: 'channel unavailable',
          }),
        );
        const retried = makeNotification('report-notification:report-1', {
          channel: 'feishu',
          payload: { title: '更新后的摘要', content: '可恢复的通知正文', level: 'warn' },
          result: 'success',
          sentAt: T2,
        });
        await repos.notification.save(retried);
        expect(await repos.notification.findById(retried.id)).toEqual(retried);
        expect(await repos.notification.listRecent()).toHaveLength(1);
      });

      it('save + findById 往返一致（含可选字段）', async () => {
        const n = makeNotification('n-1', {
          adviceId: 'adv-1',
          channel: 'feishu',
          payload: { title: 't', content: 'c', level: 'warn', atMobiles: ['13800001111'] },
        });
        await repos.notification.save(n);
        expect(await repos.notification.findById('n-1')).toEqual(n);
      });

      it('listByAdvice / listBySignal 按 sentAt 倒序', async () => {
        await repos.notification.save(makeNotification('n-1', { adviceId: 'adv-1', sentAt: T1 }));
        await repos.notification.save(makeNotification('n-2', { adviceId: 'adv-1', sentAt: T2 }));
        await repos.notification.save(
          makeNotification('n-3', { tacticSignalId: 'sig-1', sentAt: T3 }),
        );
        expect((await repos.notification.listByAdvice('adv-1')).map((n) => n.id)).toEqual([
          'n-2',
          'n-1',
        ]);
        expect((await repos.notification.listBySignal('sig-1')).map((n) => n.id)).toEqual(['n-3']);
      });

      it('listRecent 过滤 + limit', async () => {
        await repos.notification.save(
          makeNotification('n-1', { channel: 'feishu', result: 'success', sentAt: T1 }),
        );
        await repos.notification.save(
          makeNotification('n-2', {
            channel: 'feishu',
            result: 'failed',
            sentAt: T2,
            errorMessage: 'x',
          }),
        );
        await repos.notification.save(
          makeNotification('n-3', { channel: 'log', result: 'success', sentAt: T3 }),
        );
        expect(
          (await repos.notification.listRecent({ channel: 'feishu' })).map((n) => n.id),
        ).toEqual(['n-2', 'n-1']);
        expect(
          (await repos.notification.listRecent({ result: 'success' })).map((n) => n.id),
        ).toEqual(['n-3', 'n-1']);
        expect((await repos.notification.listRecent({ limit: 2 })).map((n) => n.id)).toEqual([
          'n-3',
          'n-2',
        ]);
      });

      it('违反不变量时拒绝（result=failed 缺 errorMessage）', async () => {
        await expect(
          repos.notification.save(makeNotification('bad', { result: 'failed' })),
        ).rejects.toThrow();
      });
    });

    describe('AlertPlanRepository', () => {
      it('CRUD、enabled/watchlist 过滤在双实现一致', async () => {
        const first = makeAlertPlan('alert-a');
        const second = makeAlertPlan('alert-b', {
          watchlistId: 'watchlist-2',
          enabled: false,
        });
        await repos.alertPlan.save(first);
        await repos.alertPlan.save(second);
        expect(await repos.alertPlan.findById(first.id)).toEqual(first);
        expect((await repos.alertPlan.list({ enabledOnly: true })).map((p) => p.id)).toEqual([
          'alert-a',
        ]);
        expect(
          (await repos.alertPlan.list({ watchlistId: 'watchlist-2' })).map((p) => p.id),
        ).toEqual(['alert-b']);
        await repos.alertPlan.remove(first.id);
        expect(await repos.alertPlan.findById(first.id)).toBeNull();
      });
    });

    describe('WatchTriggerRepository', () => {
      it('query 在复合筛选后分页并准确计数，同时间按 id 倒序', async () => {
        for (const id of ['a', 'c', 'b']) {
          await repos.watchTrigger.save(
            makeWatchTrigger(id, {
              priority: 'important',
              notified: false,
              deliveryStatus: 'not-requested',
            }),
          );
        }
        await repos.watchTrigger.save(makeWatchTrigger('other-stock', { stockId: '600519.SH' }));
        await repos.watchTrigger.save(makeWatchTrigger('future', { createdAt: T2 }));
        const query = {
          alertPlanId: 'pool-1',
          stockId: '002594.SZ',
          ruleKind: 'price-change' as const,
          ruleId: 'r_fixture',
          priority: 'important' as const,
          feedback: 'unreviewed' as const,
          notified: false,
          deliveryStatus: ['not-requested'] as const,
          triggerType: 'triggered' as const,
          since: T1,
          until: T1,
          offset: 1,
          limit: 1,
        };
        const page = await repos.watchTrigger.query(query);
        expect(page.total).toBe(3);
        expect(page.triggers.map((t) => t.id)).toEqual(['b']);
        expect(await repos.watchTrigger.query({ ...query, offset: 99 })).toEqual({
          triggers: [],
          total: 3,
        });
        await repos.watchTrigger.setFeedback('b', 'handled', T2);
        expect((await repos.watchTrigger.query({ ...query, offset: 0 })).total).toBe(2);
        expect(
          (
            await repos.watchTrigger.query({ ...query, feedback: 'handled', offset: 0 })
          ).triggers.map((t) => t.id),
        ).toEqual(['b']);
        expect((await repos.watchTrigger.query({ ...query, deliveryStatus: [] })).total).toBe(0);
      });

      it('query summary 聚合完整筛选范围，最高优先级与最新记录独立', async () => {
        await repos.watchTrigger.save(
          makeWatchTrigger('older', { priority: 'urgent', createdAt: T0 }),
        );
        await repos.watchTrigger.save(makeWatchTrigger('latest', { createdAt: T1 }));
        await repos.watchTrigger.setFeedback('older', 'useless', T2);
        await repos.watchTrigger.save(
          makeWatchTrigger('other', { stockId: '600519.SH', createdAt: T0 }),
        );
        const result = await repos.watchTrigger.query({
          offset: 0,
          limit: 1,
          includeSummary: true,
        });
        expect(result.triggers.map((t) => t.id)).toEqual(['latest']);
        expect(result.summary).toMatchObject({
          priorityCounts: { urgent: 1, normal: 2 },
          deliveryStatusCounts: { sent: 3 },
          feedbackCounts: { useless: 1 },
          stocks: [
            { stockId: '002594.SZ', count: 2, maxPriority: 'urgent', latest: { id: 'latest' } },
            { stockId: '600519.SH', count: 1, maxPriority: 'normal', latest: { id: 'other' } },
          ],
        });
        const filtered = await repos.watchTrigger.query({
          since: T1,
          offset: 99,
          limit: 1,
          includeSummary: true,
        });
        expect(filtered.triggers).toEqual([]);
        expect(filtered.summary).toMatchObject({
          priorityCounts: { normal: 1 },
          feedbackCounts: {},
          stocks: [{ count: 1, maxPriority: 'normal' }],
        });
        const empty = await repos.watchTrigger.query({
          since: T2,
          offset: 0,
          limit: 1,
          includeSummary: true,
        });
        expect(empty.summary).toEqual({
          priorityCounts: {},
          deliveryStatusCounts: {},
          feedbackCounts: {},
          stocks: [],
        });
        expect((await repos.watchTrigger.query({ offset: 0, limit: 1 })).summary).toBeUndefined();
      });

      it('优先级排序在分页前生效，同级按时间和 ID 排序且不改变最新记录汇总', async () => {
        await repos.watchTrigger.save(
          makeWatchTrigger('urgent-a', { priority: 'urgent', createdAt: T0 }),
        );
        await repos.watchTrigger.save(
          makeWatchTrigger('urgent-b', { priority: 'urgent', createdAt: T0 }),
        );
        await repos.watchTrigger.save(
          makeWatchTrigger('urgent-new', { priority: 'urgent', createdAt: T1 }),
        );
        await repos.watchTrigger.save(
          makeWatchTrigger('important', { priority: 'important', createdAt: T2 }),
        );
        await repos.watchTrigger.save(makeWatchTrigger('normal', { createdAt: T3 }));
        const first = await repos.watchTrigger.query({
          orderBy: 'priority',
          offset: 0,
          limit: 2,
          includeSummary: true,
        });
        expect(first.total).toBe(5);
        expect(first.triggers.map((t) => t.id)).toEqual(['urgent-new', 'urgent-b']);
        expect(first.summary?.stocks[0]).toMatchObject({
          count: 5,
          maxPriority: 'urgent',
          latest: { id: 'normal' },
        });
        const second = await repos.watchTrigger.query({ orderBy: 'priority', offset: 2, limit: 3 });
        expect(second.triggers.map((t) => t.id)).toEqual(['urgent-a', 'important', 'normal']);
        const recent = await repos.watchTrigger.query({ offset: 0, limit: 1 });
        expect(recent.triggers[0]?.id).toBe('normal');
        const filtered = await repos.watchTrigger.query({
          since: T1,
          orderBy: 'priority',
          offset: 0,
          limit: 5,
        });
        expect(filtered.triggers.map((t) => t.id)).toEqual(['urgent-new', 'important', 'normal']);
      });

      it('query 不再截断 1 万条，旧股票记录可以在筛选后查到', async () => {
        await repos.watchTrigger.save(
          makeWatchTrigger('old-match', { stockId: '600519.SH', createdAt: T0 }),
        );
        for (let i = 0; i < 10001; i += 1) {
          await repos.watchTrigger.save(makeWatchTrigger(`bulk-${String(i).padStart(5, '0')}`));
        }
        const all = await repos.watchTrigger.query({
          offset: 10001,
          limit: 1,
          includeSummary: true,
        });
        expect(all.total).toBe(10002);
        expect(all.summary?.stocks.map((s) => s.count)).toEqual([10001, 1]);
        expect(all.triggers.map((t) => t.id)).toEqual(['old-match']);
        const filtered = await repos.watchTrigger.query({
          stockId: '600519.SH',
          offset: 0,
          limit: 1,
        });
        expect(filtered.total).toBe(1);
        expect(filtered.triggers[0]?.id).toBe('old-match');
      }, 20000);

      it('求值提交同时保存触发和边沿', async () => {
        const state = {
          poolId: 'pool-1',
          stockId: '002594.SZ',
          ruleId: 'r_fixture',
          active: true,
          lastEvaluatedAt: T1,
        };
        const input = {
          now: T1,
          triggers: [makeWatchTrigger('atomic')],
          auditTriggers: [
            makeWatchTrigger('expired-audit', {
              deliveryStatus: 'expired',
              notified: false,
              evalSnapshot: { publicationReason: '超过 10 分钟' },
            }),
          ],
          states: [state],
        };
        await repos.watchTrigger.commitEvaluation(input);
        expect(await repos.watchTrigger.findById('atomic')).toMatchObject({ id: 'atomic' });
        expect(await repos.watchTrigger.findById('expired-audit')).toMatchObject({
          deliveryStatus: 'expired',
          evalSnapshot: { publicationReason: '超过 10 分钟' },
        });
        expect(await repos.watchRuleState.listByPool('pool-1')).toMatchObject([state]);
      });

      it('批次中一条非法触发不会留下部分触发或边沿', async () => {
        await expect(
          repos.watchTrigger.commitEvaluation({
            now: T1,
            triggers: [makeWatchTrigger('valid'), makeWatchTrigger('invalid', { evidence: [] })],
            states: [
              {
                poolId: 'pool-1',
                stockId: '002594.SZ',
                ruleId: 'r_fixture',
                active: true,
                lastEvaluatedAt: T1,
              },
            ],
          }),
        ).rejects.toThrow();
        expect(await repos.watchTrigger.findById('valid')).toBeNull();
        expect(await repos.watchRuleState.listByPool('pool-1')).toEqual([]);
      });

      it('闭市时原子作废待发送触发并释放边沿，保留已记录的投递尝试', async () => {
        const state = {
          poolId: 'pool-1',
          stockId: '002594.SZ',
          ruleId: 'r_fixture',
          active: true,
          firstTriggeredAt: T1,
          lastEvaluatedAt: T1,
        };
        await repos.watchTrigger.commitEvaluation({
          now: T1,
          triggers: [makeWatchTrigger('session-pending', { deliveryStatus: 'pending' })],
          states: [state],
        });
        await repos.watchTrigger.beginDelivery(['session-pending'], T1);
        await repos.watchTrigger.commitEvaluation({
          now: T2,
          triggers: [],
          states: [{ ...state, active: false, firstTriggeredAt: undefined }],
          invalidatePending: {
            triggerIds: ['session-pending'],
            reason: '闭市后不再发送',
          },
        });
        expect(await repos.watchTrigger.findById('session-pending')).toMatchObject({
          deliveryStatus: 'invalidated',
          deliveryAttempts: 1,
          lastDeliveryAttemptAt: T1,
          deliveryCompletedAt: T2,
          evalSnapshot: {
            publicationCheckedAt: T2.toISOString(),
            publicationReason: '闭市后不再发送',
          },
        });
        const states = await repos.watchRuleState.listByPool('pool-1');
        expect(states).toMatchObject([{ active: false }]);
        expect(states[0]?.firstTriggeredAt).toBeUndefined();
      });

      it('投递前记录尝试，pending 和重试也占每日额度，回写不重复计数', async () => {
        await repos.watchTrigger.save(
          makeWatchTrigger('delivery', {
            deliveryStatus: 'pending',
            notified: false,
          }),
        );
        expect(await repos.watchTrigger.countAttemptedSince(FAR_PAST)).toBe(0);
        await repos.watchTrigger.beginDelivery(['delivery'], T1);
        expect(await repos.watchTrigger.findById('delivery')).toMatchObject({
          deliveryAttempts: 1,
          lastDeliveryAttemptAt: T1,
          deliveryStatus: 'pending',
        });
        expect(await repos.watchTrigger.countAttemptedSince(FAR_PAST)).toBe(1);
        await repos.watchTrigger.setDeliveryStatus(['delivery'], 'failed', undefined, T1);
        expect(await repos.watchTrigger.findById('delivery')).toMatchObject({
          deliveryCompletedAt: T1,
        });
        await repos.watchTrigger.beginDelivery(['delivery'], T2);
        expect(
          (await repos.watchTrigger.findById('delivery'))?.deliveryCompletedAt,
        ).toBeUndefined();
        await repos.watchTrigger.setDeliveryStatus(['delivery'], 'sent', 'notification', T3);
        expect(await repos.watchTrigger.findById('delivery')).toMatchObject({
          deliveryAttempts: 2,
          lastDeliveryAttemptAt: T2,
          deliveryCompletedAt: T3,
          notificationId: 'notification',
        });
        expect(await repos.watchTrigger.countAttemptedSince(FAR_PAST)).toBe(2);
      });

      it('旧失败记录重试时保留原来一次尝试', async () => {
        await repos.watchTrigger.save(
          makeWatchTrigger('legacy-failed', { deliveryStatus: 'failed' }),
        );
        await repos.watchTrigger.beginDelivery(['legacy-failed'], T1);
        expect(await repos.watchTrigger.findById('legacy-failed')).toMatchObject({
          deliveryAttempts: 2,
        });
      });

      it('save + findById 往返一致', async () => {
        const t = makeWatchTrigger('tr-1');
        await repos.watchTrigger.save(t);
        expect(await repos.watchTrigger.findById('tr-1')).toEqual(t);
        expect(await repos.watchTrigger.findById('missing')).toBeNull();
      });

      it('save 缺省 alertPlanId 时回填 poolId', async () => {
        const { alertPlanId: _alertPlanId, ...legacy } = makeWatchTrigger('tr-legacy', {
          poolId: 'pool-legacy',
        });
        await repos.watchTrigger.save(legacy);
        expect((await repos.watchTrigger.findById('tr-legacy'))?.alertPlanId).toBe('pool-legacy');
      });

      it('listByPool 按 createdAt 倒序 + since 过滤', async () => {
        await repos.watchTrigger.save(makeWatchTrigger('tr-1', { createdAt: T1, poolId: 'p1' }));
        await repos.watchTrigger.save(makeWatchTrigger('tr-2', { createdAt: T2, poolId: 'p1' }));
        await repos.watchTrigger.save(makeWatchTrigger('tr-3', { createdAt: T3, poolId: 'p2' }));
        expect((await repos.watchTrigger.listByPool('p1')).map((t) => t.id)).toEqual([
          'tr-2',
          'tr-1',
        ]);
        expect((await repos.watchTrigger.listByPool('p1', { since: T1 })).map((t) => t.id)).toEqual(
          ['tr-2', 'tr-1'],
        );
      });

      it('lastForKey 找 (poolId, stockId, ruleId) 维度最近一条', async () => {
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-old', {
            createdAt: T1,
            poolId: 'p1',
            stockId: 's1',
            ruleId: 'r_a',
            ruleKind: 'price-change',
          }),
        );
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-new', {
            createdAt: T3,
            poolId: 'p1',
            stockId: 's1',
            ruleId: 'r_a',
            ruleKind: 'price-change',
          }),
        );
        // 不同 ruleId → 不命中
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-other', {
            createdAt: T3,
            poolId: 'p1',
            stockId: 's1',
            ruleId: 'r_b',
            ruleKind: 'price-change',
          }),
        );
        const hit = await repos.watchTrigger.lastForKey(
          { poolId: 'p1', stockId: 's1', ruleId: 'r_a' },
          FAR_PAST,
        );
        expect(hit?.id).toBe('tr-new');
        const miss = await repos.watchTrigger.lastForKey(
          { poolId: 'p1', stockId: 's1', ruleId: 'r_other' },
          FAR_PAST,
        );
        expect(miss).toBeNull();
        // since 过滤：T1 之前的应被剔除
        const cutoff = await repos.watchTrigger.lastForKey(
          { poolId: 'p1', stockId: 's1', ruleId: 'r_a' },
          T2,
        );
        expect(cutoff?.id).toBe('tr-new');
      });

      it('lastForKey 仅返回 ATTEMPTED 状态记录；试跑（not-requested）不占 cooldown', async () => {
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-notified', {
            createdAt: T1,
            poolId: 'p1',
            stockId: 's1',
            ruleId: 'r_a',
            ruleKind: 'price-change',
            deliveryStatus: 'sent',
            notified: true,
          }),
        );
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-dry-run', {
            createdAt: T3,
            poolId: 'p1',
            stockId: 's1',
            ruleId: 'r_a',
            ruleKind: 'price-change',
            deliveryStatus: 'not-requested',
            notified: false,
          }),
        );
        const hit = await repos.watchTrigger.lastForKey(
          { poolId: 'p1', stockId: 's1', ruleId: 'r_a' },
          FAR_PAST,
        );
        // ATTEMPTED 优先；T3 更新但 deliveryStatus='not-requested' → 命中通知过的旧记录
        expect(hit?.id).toBe('tr-notified');
      });

      it('lastForKey 把 failed 视为 ATTEMPTED（避免失败重试风暴）', async () => {
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-failed', {
            createdAt: T1,
            poolId: 'p1',
            stockId: 's1',
            ruleId: 'r_a',
            ruleKind: 'price-change',
            deliveryStatus: 'failed',
            notified: true,
          }),
        );
        const hit = await repos.watchTrigger.lastForKey(
          { poolId: 'p1', stockId: 's1', ruleId: 'r_a' },
          FAR_PAST,
        );
        expect(hit?.id).toBe('tr-failed');
      });

      it('countAttemptedSince 按 poolId / 全局计数 ATTEMPTED', async () => {
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-1', {
            createdAt: T1,
            poolId: 'p1',
            deliveryStatus: 'sent',
            notified: true,
          }),
        );
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-2', {
            createdAt: T2,
            poolId: 'p1',
            deliveryStatus: 'failed',
            notified: true,
          }),
        );
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-3', {
            createdAt: T3,
            poolId: 'p1',
            deliveryStatus: 'not-requested',
            notified: false,
          }),
        );
        expect(await repos.watchTrigger.countAttemptedSince(FAR_PAST, 'p1')).toBe(2);
        expect(await repos.watchTrigger.countAttemptedSince(FAR_PAST, null)).toBe(2);
        expect(await repos.watchTrigger.countAttemptedSince(T2, null)).toBe(1); // T2 起只有 tr-2
      });

      it('listRecent 支持 poolId / since / limit', async () => {
        await repos.watchTrigger.save(makeWatchTrigger('tr-1', { createdAt: T1, poolId: 'p1' }));
        await repos.watchTrigger.save(makeWatchTrigger('tr-2', { createdAt: T2, poolId: 'p2' }));
        await repos.watchTrigger.save(makeWatchTrigger('tr-3', { createdAt: T3, poolId: 'p1' }));
        expect((await repos.watchTrigger.listRecent({ poolId: 'p1' })).map((t) => t.id)).toEqual([
          'tr-3',
          'tr-1',
        ]);
        expect((await repos.watchTrigger.listRecent({ since: T2 })).map((t) => t.id)).toEqual([
          'tr-3',
          'tr-2',
        ]);
        expect((await repos.watchTrigger.listRecent({ limit: 2 })).map((t) => t.id)).toEqual([
          'tr-3',
          'tr-2',
        ]);
      });

      it('remove 后 findById=null', async () => {
        await repos.watchTrigger.save(makeWatchTrigger('tr-x'));
        await repos.watchTrigger.remove('tr-x');
        expect(await repos.watchTrigger.findById('tr-x')).toBeNull();
      });
    });

    describe('ResearchIndexRepository', () => {
      it('document-only upsert 后按 kind/tags/stockCode 与正文搜索', async () => {
        const summary = await repos.researchIndex.applyIndexBatch({
          vaultId: 'vault-test',
          completeness: 'complete',
          documents: [
            makeResearchDocument('report', {
              title: '库存周期见底',
              tags: ['周期'],
              stockCodes: ['600519.SH'],
              excerpt: '渠道库存下降',
            }),
            makeResearchDocument('article', {
              kind: 'article',
              title: '行业跟踪',
              stockCodes: ['000858.SZ'],
              contentHash: 'c'.repeat(64),
            }),
          ],
          contents: { doc_report: '经销商库存连续三个月下降，价格企稳。' },
          seenDocumentIds: new Set(['doc_report', 'doc_article']),
          indexedAt: T2,
        });
        expect(summary).toMatchObject({ added: 2, updated: 0, unchanged: 0, missing: 0 });
        expect(repos.researchIndex.searchCapability()).toBe('fts');
        expect((await repos.researchIndex.findDocument('doc_report'))?.stockCodes).toEqual([
          '600519.SH',
        ]);
        expect(await repos.researchIndex.listStockCodes()).toEqual(['000858.SZ', '600519.SH']);

        const all = await repos.researchIndex.listDocuments({});
        expect(all.map((document) => document.id)).toEqual(['doc_article', 'doc_report']);
        expect(
          (await repos.researchIndex.listDocuments({ kind: 'article' })).map(
            (document) => document.id,
          ),
        ).toEqual(['doc_article']);
        expect(
          (await repos.researchIndex.listDocuments({ stockCode: '600519.SH' })).map(
            (document) => document.id,
          ),
        ).toEqual(['doc_report']);
        expect(
          (await repos.researchIndex.listDocuments({ tags: ['周期'] })).map(
            (document) => document.id,
          ),
        ).toEqual(['doc_report']);

        const hits = await repos.researchIndex.searchDocuments({ text: '库存' });
        expect(hits.map((hit) => hit.document.id)).toEqual(['doc_report']);
        expect(hits[0]?.snippet).toContain('库存');
        expect(
          (await repos.researchIndex.searchDocuments({ text: '库存', stockCode: '000858.SZ' })).map(
            (hit) => hit.document.id,
          ),
        ).toEqual([]);
        expect(await repos.researchIndex.searchDocuments({ text: '   ' })).toEqual([]);
      });

      it('完整扫描把未出现文档标记 missing、移出搜索并可保留股票代码索引', async () => {
        await repos.researchIndex.applyIndexBatch({
          vaultId: 'vault-test',
          completeness: 'complete',
          documents: [makeResearchDocument('keep'), makeResearchDocument('drop')],
          contents: { doc_keep: 'Searchable body', doc_drop: 'will be removed' },
          seenDocumentIds: new Set(['doc_keep', 'doc_drop']),
          indexedAt: T1,
        });
        const summary = await repos.researchIndex.applyIndexBatch({
          vaultId: 'vault-test',
          completeness: 'complete',
          documents: [makeResearchDocument('keep')],
          contents: { doc_keep: 'Searchable body' },
          seenDocumentIds: new Set(['doc_keep']),
          indexedAt: T2,
        });
        expect(summary).toMatchObject({ unchanged: 1, missing: 1 });
        expect((await repos.researchIndex.findDocument('doc_drop'))?.availability).toBe('missing');
        expect(
          (await repos.researchIndex.searchDocuments({ text: 'Searchable' })).map(
            (hit) => hit.document.id,
          ),
        ).toEqual(['doc_keep']);
        expect(await repos.researchIndex.listStockCodes()).toEqual([]);
      });

      it('报告 invalid/conflict 计数且不改写既有文档', async () => {
        await repos.researchIndex.applyIndexBatch({
          vaultId: 'vault-test',
          completeness: 'complete',
          documents: [
            makeResearchDocument('valid'),
            makeResearchDocument('bad', {
              contentHash: 'd'.repeat(64),
              availability: 'invalid',
            }),
            makeResearchDocument('clash', {
              contentHash: 'e'.repeat(64),
              availability: 'conflict',
            }),
          ],
          contents: { doc_valid: '正常正文' },
          seenDocumentIds: new Set(['doc_valid', 'doc_bad', 'doc_clash']),
          indexedAt: T1,
        });
        const summary = await repos.researchIndex.applyIndexBatch({
          vaultId: 'vault-test',
          completeness: 'partial',
          documents: [
            makeResearchDocument('valid', {
              title: '更新标题',
              contentHash: 'f'.repeat(64),
            }),
          ],
          contents: { doc_valid: '正常正文' },
          seenDocumentIds: new Set(['doc_valid']),
          indexedAt: T2,
        });
        expect(summary).toMatchObject({ added: 0, updated: 1, invalid: 0, conflicts: 0 });
        expect((await repos.researchIndex.findDocument('doc_valid'))?.title).toBe('更新标题');
        expect((await repos.researchIndex.findDocument('doc_bad'))?.availability).toBe('invalid');
        expect((await repos.researchIndex.findDocument('doc_clash'))?.availability).toBe(
          'conflict',
        );
      });
    });

    describe('WorkflowRunRepository', () => {
      it('running → succeeded upsert；listRecent 按 startedAt 倒序 + 过滤', async () => {
        await repos.workflowRun.save(
          makeWorkflowRun('w1', { status: 'running', startedAt: T1, finishedAt: undefined }),
        );
        await repos.workflowRun.save(makeWorkflowRun('w1', { startedAt: T1, finishedAt: T2 }));
        await repos.workflowRun.save(
          makeWorkflowRun('w2', {
            workflowName: 'closing-report',
            startedAt: T3,
            finishedAt: T3,
            status: 'partial',
          }),
        );
        expect((await repos.workflowRun.findById('w1'))?.status).toBe('succeeded');
        const recent = await repos.workflowRun.listRecent();
        expect(recent.map((r) => r.id)).toEqual(['w2', 'w1']);
        const byName = await repos.workflowRun.listRecent({ workflowName: 'post-market-data' });
        expect(byName.map((r) => r.id)).toEqual(['w1']);
      });

      it('strategy-daily-cycle 先按归属和 dataAsOf 过滤，再应用 limit/offset', async () => {
        await repos.workflowRun.save(
          makeWorkflowRun('cycle-other-newer', {
            workflowName: 'strategy-daily-cycle',
            startedAt: T3,
            finishedAt: T3,
            inputSummary: {
              strategyId: 'strategy-other',
              scheduleId: 'schedule-other',
              dataAsOf: T3,
            },
          }),
        );
        await repos.workflowRun.save(
          makeWorkflowRun('cycle-target-latest-data', {
            workflowName: 'strategy-daily-cycle',
            startedAt: T1,
            finishedAt: T2,
            inputSummary: {
              strategyId: 'strategy-target',
              scheduleId: 'schedule-target',
              dataAsOf: T3,
            },
          }),
        );
        await repos.workflowRun.save(
          makeWorkflowRun('cycle-target-old-data', {
            workflowName: 'strategy-daily-cycle',
            startedAt: T3,
            finishedAt: T3,
            inputSummary: {
              strategyId: 'strategy-target',
              scheduleId: 'schedule-target',
              dataAsOf: T1,
            },
          }),
        );

        const first = await repos.workflowRun.listStrategyDailyCycleAudits({
          strategyId: 'strategy-target',
          scheduleId: 'schedule-target',
          since: T2,
          limit: 1,
        });
        expect(first.map((run) => run.id)).toEqual(['cycle-target-latest-data']);
        expect(
          await repos.workflowRun.listStrategyDailyCycleAudits({
            strategyId: 'strategy-target',
            scheduleId: 'schedule-target',
            since: T2,
            limit: 1,
            offset: 1,
          }),
        ).toEqual([]);
      });

      it('failed 缺 error 时拒绝', async () => {
        await expect(
          repos.workflowRun.save(makeWorkflowRun('w-bad', { status: 'failed', error: undefined })),
        ).rejects.toThrow();
      });
    });

    describe('ReportRepository', () => {
      it('最新报告先按周期收敛再应用状态和条数筛选，历史仍可读取', async () => {
        const first = await repos.report.upsertForPeriod(makeReport('history-main'));
        const gap = { dimension: 'market', reason: '源不可用', retryable: true };
        const latest = await repos.report.upsertForPeriod(
          makeReport('history-latest', {
            version: 2,
            supersedesReportId: first.id,
            status: 'partial',
            sections: [
              {
                key: 'market',
                title: '市场',
                required: true,
                status: 'unavailable',
                blocks: [{ kind: 'text', text: '源不可用', tone: 'warning' }],
                evidenceIds: [],
                missingDimensions: [gap],
              },
            ],
            missingDimensions: [gap],
          }),
        );
        const earlier = await repos.report.upsertForPeriod(
          makeReport('earlier-report', {
            periodStart: '2026-07-01',
            periodEnd: '2026-07-01',
          }),
        );
        expect(
          (await repos.report.list({ latestOnly: true, limit: 2 })).map((report) => report.id),
        ).toEqual([latest.id, earlier.id]);
        expect(
          (await repos.report.list({ latestOnly: true, status: 'complete', limit: 2 })).map(
            (report) => report.id,
          ),
        ).toEqual([earlier.id]);
        expect(await repos.report.findById(first.id)).toEqual(first);
        expect(await repos.report.list()).toHaveLength(3);
      });
      it('投递领取跨重试保持互斥，过期接管后旧执行者不能回写', async () => {
        await repos.report.upsertForPeriod(makeReport('delivery-claim'));
        const claim = (attemptId: string, now: Date) =>
          repos.report.claimDelivery({
            id: 'delivery-claim',
            attemptId,
            now,
            stalePendingBefore: new Date(now.getTime() - 5 * 60_000),
            failedRetryBefore: new Date(now.getTime() - 15 * 60_000),
          });
        const firstAt = new Date('2026-07-03T01:00:00.000Z');
        expect(await claim('first', firstAt)).toBe(true);
        expect(await claim('second', new Date(firstAt.getTime() + 60_000))).toBe(false);
        const takeoverAt = new Date(firstAt.getTime() + 6 * 60_000);
        expect(await claim('second', takeoverAt)).toBe(true);
        expect(
          await repos.report.finishDelivery({
            id: 'delivery-claim',
            attemptId: 'first',
            status: 'sent',
            now: takeoverAt,
          }),
        ).toBe(false);
        expect(
          await repos.report.finishDelivery({
            id: 'delivery-claim',
            attemptId: 'second',
            status: 'failed',
            now: takeoverAt,
          }),
        ).toBe(true);
        expect(await claim('third', new Date(takeoverAt.getTime() + 14 * 60_000))).toBe(false);
        const retryAt = new Date(takeoverAt.getTime() + 16 * 60_000);
        expect(await claim('third', retryAt)).toBe(true);
        expect(
          await repos.report.finishDelivery({
            id: 'delivery-claim',
            attemptId: 'third',
            status: 'sent',
            now: retryAt,
          }),
        ).toBe(true);
        expect(await claim('fourth', new Date(retryAt.getTime() + 60 * 60_000))).toBe(false);
        expect((await repos.report.findById('delivery-claim'))?.deliveryStatus).toBe('sent');
      });

      it('仅记日志的报告冷却后可重新领取投递，渠道受理后终止重试', async () => {
        await repos.report.upsertForPeriod(makeReport('fallback-retry'));
        const firstAt = new Date('2026-07-03T01:00:00.000Z');
        const claim = (attemptId: string, now: Date) =>
          repos.report.claimDelivery({
            id: 'fallback-retry',
            attemptId,
            now,
            stalePendingBefore: new Date(now.getTime() - 5 * 60_000),
            failedRetryBefore: new Date(now.getTime() - 15 * 60_000),
          });
        expect(await claim('unconfigured', firstAt)).toBe(true);
        expect(
          await repos.report.finishDelivery({
            id: 'fallback-retry',
            attemptId: 'unconfigured',
            status: 'fallback-log',
            now: firstAt,
          }),
        ).toBe(true);
        expect(await claim('too-soon', new Date(firstAt.getTime() + 14 * 60_000))).toBe(false);
        const retryAt = new Date(firstAt.getTime() + 16 * 60_000);
        expect(await claim('configured', retryAt)).toBe(true);
        expect(
          await repos.report.finishDelivery({
            id: 'fallback-retry',
            attemptId: 'configured',
            status: 'sent',
            now: retryAt,
          }),
        ).toBe(true);
        expect(await claim('repeated', new Date(retryAt.getTime() + 60 * 60_000))).toBe(false);
      });

      it('upsertForPeriod 后可按 id 和逻辑周期读取', async () => {
        const fixture = makeReport('report-1');
        const saved = await repos.report.upsertForPeriod({
          ...fixture,
          sections: fixture.sections.map((section) => ({
            ...section,
            inputFingerprint: 'a'.repeat(64),
          })),
        });

        expect((await repos.report.findById(saved.id))?.title).toBe('收盘复盘-report-1');
        expect((await repos.report.findById(saved.id))?.sections[0]?.inputFingerprint).toBe(
          'a'.repeat(64),
        );
        expect(
          await repos.report.findByPeriod({
            kind: 'closing',
            scopeKey: 'all-accounts',
            periodStart: '2026-07-02',
            periodEnd: '2026-07-02',
          }),
        ).toEqual(saved);
      });

      it('收盘补充保留原版本，按版本查询与最新查询均可追溯', async () => {
        const original = await repos.report.upsertForPeriod(makeReport('report-original'));
        const supplement = await repos.report.upsertForPeriod(
          makeReport('report-new-id', {
            version: 2,
            supersedesReportId: original.id,
            title: '重跑后的收盘复盘',
            workflowRunId: 'workflow-run-2',
            generatedAt: T3,
            updatedAt: T3,
          }),
        );

        expect(supplement.id).toBe('report-new-id');
        expect(supplement.version).toBe(2);
        expect((await repos.report.findById(original.id))?.title).toBe(original.title);
        expect(
          await repos.report.findByPeriodVersion({
            kind: 'closing',
            scopeKey: 'all-accounts',
            periodStart: '2026-07-02',
            periodEnd: '2026-07-02',
            version: 1,
          }),
        ).toEqual(original);
        expect(
          (
            await repos.report.findByPeriod({
              kind: 'closing',
              scopeKey: 'all-accounts',
              periodStart: '2026-07-02',
              periodEnd: '2026-07-02',
            })
          )?.id,
        ).toBe(supplement.id);
        expect(await repos.report.upsertForPeriod(makeReport('report-overwrite'))).toEqual(
          original,
        );
        await expect(repos.report.remove(original.id)).rejects.toThrow(/has supplements/);
      });

      it('同周期周报保留不可变主版和补充版', async () => {
        const weekly = makeReport('weekly-original', {
          kind: 'weekly',
          periodStart: '2026-06-29',
          periodEnd: '2026-07-02',
          title: '原周报',
        });
        const original = await repos.report.upsertForPeriod(weekly);
        const attemptedOverwrite = await repos.report.upsertForPeriod({
          ...weekly,
          id: 'weekly-overwrite',
          title: '不应覆盖',
        });
        expect(attemptedOverwrite.id).toBe(original.id);
        expect((await repos.report.findById(original.id))?.title).toBe('原周报');
        const supplement = await repos.report.upsertForPeriod({
          ...weekly,
          id: 'weekly-supplement',
          version: 2,
          supersedesReportId: original.id,
          title: '周报补充',
        });
        expect(supplement.version).toBe(2);
        expect((await repos.report.findById(original.id))?.title).toBe('原周报');
        expect(
          (
            await repos.report.findByPeriod({
              kind: 'weekly',
              scopeKey: 'all-accounts',
              periodStart: '2026-06-29',
              periodEnd: '2026-07-02',
            })
          )?.id,
        ).toBe(supplement.id);
      });

      it('并发写入同一收盘版本只保留一份主报告', async () => {
        const [first, second] = await Promise.all([
          repos.report.upsertForPeriod(makeReport('concurrent-first')),
          repos.report.upsertForPeriod(makeReport('concurrent-second')),
        ]);
        expect(first.id).toBe(second.id);
        expect(await repos.report.list({ kind: 'closing' })).toHaveLength(1);
      });

      it('list 按周期倒序并支持 kind/scope/status/date/limit 过滤', async () => {
        await repos.report.upsertForPeriod(makeReport('r1'));
        await repos.report.upsertForPeriod(
          makeReport('r2', {
            kind: 'opening',
            periodStart: '2026-07-03',
            periodEnd: '2026-07-03',
          }),
        );
        await repos.report.upsertForPeriod(
          makeReport('r3', {
            scope: { kind: 'account', accountId: 'acc-1' },
            periodStart: '2026-07-04',
            periodEnd: '2026-07-04',
          }),
        );

        expect((await repos.report.list({ limit: 2 })).map((report) => report.id)).toEqual([
          'r3',
          'r2',
        ]);
        expect(
          (
            await repos.report.list({
              kind: 'closing',
              scopeKey: 'account:acc-1',
              status: 'complete',
              from: '2026-07-04',
              to: '2026-07-04',
            })
          ).map((report) => report.id),
        ).toEqual(['r3']);
      });

      it('sent 不得回退为 pending', async () => {
        const saved = await repos.report.upsertForPeriod(
          makeReport('report-sent', { deliveryStatus: 'sent' }),
        );

        await expect(repos.report.setDeliveryStatus(saved.id, 'pending')).rejects.toThrow();
        expect((await repos.report.findById(saved.id))?.deliveryStatus).toBe('sent');
      });

      it('remove 删除后按 id 与逻辑周期均不可读，重复删除为幂等空操作', async () => {
        const saved = await repos.report.upsertForPeriod(makeReport('report-remove'));

        await repos.report.remove(saved.id);

        expect(await repos.report.findById(saved.id)).toBeNull();
        expect(
          await repos.report.findByPeriod({
            kind: 'closing',
            scopeKey: 'all-accounts',
            periodStart: '2026-07-02',
            periodEnd: '2026-07-02',
          }),
        ).toBeNull();
        await expect(repos.report.remove(saved.id)).resolves.toBeUndefined();
      });
    });

    describe('StrategyBacktestRepository', () => {
      const spec: StrictBacktestSpec = {
        schemaVersion: 1,
        strategyId: 'strategy-1',
        strategyVersionId: 'strategy-1-v1',
        evaluationSessionId: 'evaluation-1',
        from: T1,
        to: T3,
        initialCash: 1_000_000,
        benchmark: { stockId: '000300.SH', datasetVersion: '000300.SH:qfq:daily:v1' },
        execution: {
          model: 'next-open-full-rebalance-equal-weight-v1',
          lotSize: 100,
          maxPositions: 20,
        },
        fees: {
          model: 'ashare-fees-v1',
          commissionBps: 2.5,
          minimumCommission: 5,
          sellStampDutyBps: 5,
        },
        slippage: { model: 'fixed-bps-at-open-v1', buyBps: 5, sellBps: 5 },
      };
      const gateAudit: StrictBacktestGateAudit = {
        status: 'complete',
        assessedAt: T2,
        items: [
          'pit-universe',
          'daily-bar-revisions',
          'fees',
          'slippage',
          'tradability',
          'corporate-actions',
          'benchmark',
          'evaluator-code',
        ].map((key) => ({
          key: key as StrictBacktestGateAudit['items'][number]['key'],
          status: 'complete' as const,
          reason: 'fixture-complete',
          evidenceRefs: [],
        })),
      };

      it('保存不可变运行身份并按策略倒序查询', async () => {
        const run: StrictBacktestRun = {
          id: 'strict-backtest-1',
          status: 'queued',
          resultAvailability: 'complete',
          spec,
          specHash: strictBacktestSpecHash(spec),
          inputFingerprint: strictBacktestHash('input-1'),
          evaluator: CURRENT_STRATEGY_EVALUATOR_IDENTITY,
          gateAudit,
          createdAt: T1,
        };
        await repos.strategyBacktest.saveRun(run);
        await repos.strategyBacktest.saveRun({ ...run, status: 'running', startedAt: T2 });
        expect(await repos.strategyBacktest.findRunById(run.id)).toMatchObject({
          id: run.id,
          status: 'running',
          inputFingerprint: run.inputFingerprint,
        });
        expect(await repos.strategyBacktest.listRuns({ strategyId: spec.strategyId })).toHaveLength(
          1,
        );
        await expect(
          repos.strategyBacktest.saveRun({
            ...run,
            inputFingerprint: strictBacktestHash('changed'),
          }),
        ).rejects.toThrow('immutable identity');
      });
    });

    describe('LimitUpLadderSnapshotRepository', () => {
      it('按交易日和来源保存、读取并保留完整快照', async () => {
        const snapshot = makeLimitUpLadder();
        await repos.limitUpLadderSnapshot.save(snapshot);
        expect(
          await repos.limitUpLadderSnapshot.findByDate({
            date: snapshot.date,
            source: snapshot.source,
          }),
        ).toEqual(snapshot);
        expect(
          await repos.limitUpLadderSnapshot.findByDate({
            date: '2026-07-02',
            source: snapshot.source,
          }),
        ).toBeNull();
      });

      it('同一交易日重复采集按 date/source 幂等更新，不串其它日期', async () => {
        const first = makeLimitUpLadder();
        const second = makeLimitUpLadder({
          total: 2,
          maxLevel: 4,
          asOf: T2,
        });
        await repos.limitUpLadderSnapshot.save(first);
        await repos.limitUpLadderSnapshot.save(second);
        await repos.limitUpLadderSnapshot.save(makeLimitUpLadder({ date: '2026-07-02' }));
        await expect(
          repos.limitUpLadderSnapshot.findByDate({ date: first.date, source: first.source }),
        ).resolves.toEqual(second);
        await expect(
          repos.limitUpLadderSnapshot.findByDate({ date: '2026-07-02', source: first.source }),
        ).resolves.toMatchObject({ date: '2026-07-02', total: 1 });
      });
    });

    describe('MarketSnapshotBatchRepository', () => {
      it('发布后按 id 与最近批次读取完整快照', async () => {
        const batch = makeMarketSnapshotBatch();
        const published = await repos.marketSnapshotBatch.publish(batch);
        expect(published).toEqual({ created: true, batch });
        expect(await repos.marketSnapshotBatch.findById(batch.id)).toEqual(batch);
        expect(await repos.marketSnapshotBatch.findLatest()).toEqual(batch);
        expect(
          await repos.marketSnapshotBatch.findLatest({ coverage: 'CN_A_SHARES_SH_SZ' }),
        ).toEqual(batch);
      });

      it('同一批次重试保留首次发布内容，不产生第二份', async () => {
        const first = makeMarketSnapshotBatch();
        await repos.marketSnapshotBatch.publish(first);
        const changed = makeMarketSnapshotBatch({
          fetchedAt: new Date('2026-09-28T02:18:30.000Z'),
          source: 'tencent',
          items: [first.items[0] as NonNullable<(typeof first.items)[0]>],
          completeness: {
            expectedCount: 2,
            receivedCount: 1,
            missingCount: 1,
            duplicateCount: 0,
            complete: false,
          },
          gaps: ['missing_items: 期望 2 只，实收 1 只，缺 1 只'],
        });
        await expect(repos.marketSnapshotBatch.publish(changed)).resolves.toEqual({
          created: false,
          batch: first,
        });
        expect(await repos.marketSnapshotBatch.findLatest()).toEqual(first);
      });

      it('不同采样时点分别发布，最近批次按采样时点倒序', async () => {
        const earlier = makeMarketSnapshotBatch();
        const later = makeMarketSnapshotBatch({
          id: 'CN_A_SHARES_SH_SZ|2026-09-28T02:20:00.000Z',
          sampledAt: new Date('2026-09-28T02:20:00.000Z'),
          fetchedAt: new Date('2026-09-28T02:21:01.000Z'),
          source: 'tencent',
        });
        await repos.marketSnapshotBatch.publish(earlier);
        await repos.marketSnapshotBatch.publish(later);
        expect(await repos.marketSnapshotBatch.findLatest()).toEqual(later);
        expect(await repos.marketSnapshotBatch.findById(earlier.id)).toEqual(earlier);
        expect(
          await repos.marketSnapshotBatch.findLatest({ coverage: 'CN_A_SHARES_BJ' }),
        ).toBeNull();
      });

      it('按交易日与同时点容差查找对比批次，超出容差不拿相邻时点冒充', async () => {
        const previous = makeMarketSnapshotBatch({
          id: 'CN_A_SHARES_SH_SZ|2026-09-24T02:15:00.000Z',
          tradingDate: '2026-09-24',
          sampledAt: new Date('2026-09-24T02:15:00.000Z'),
          fetchedAt: new Date('2026-09-24T02:16:01.000Z'),
        });
        await repos.marketSnapshotBatch.publish(previous);
        await repos.marketSnapshotBatch.publish(makeMarketSnapshotBatch());

        await expect(
          repos.marketSnapshotBatch.findNearestAt({
            coverage: 'CN_A_SHARES_SH_SZ',
            tradingDate: '2026-09-24',
            sampledAt: new Date('2026-09-24T02:15:30.000Z'),
            toleranceMs: 60_000,
          }),
        ).resolves.toEqual(previous);
        await expect(
          repos.marketSnapshotBatch.findNearestAt({
            tradingDate: '2026-09-24',
            sampledAt: new Date('2026-09-24T02:20:00.000Z'),
            toleranceMs: 60_000,
          }),
        ).resolves.toBeNull();
        await expect(
          repos.marketSnapshotBatch.findNearestAt({
            tradingDate: '2026-09-23',
            sampledAt: new Date('2026-09-23T02:15:00.000Z'),
            toleranceMs: 60_000,
          }),
        ).resolves.toBeNull();
        await expect(
          repos.marketSnapshotBatch.findNearestAt({
            coverage: 'CN_A_SHARES_BJ',
            tradingDate: '2026-09-24',
            sampledAt: new Date('2026-09-24T02:15:00.000Z'),
            toleranceMs: 60_000,
          }),
        ).resolves.toBeNull();
      });

      it('容差内多个候选时取采样时点最近的一份', async () => {
        const earlier = makeMarketSnapshotBatch({
          id: 'CN_A_SHARES_SH_SZ|2026-09-24T02:10:00.000Z',
          tradingDate: '2026-09-24',
          sampledAt: new Date('2026-09-24T02:10:00.000Z'),
        });
        const later = makeMarketSnapshotBatch({
          id: 'CN_A_SHARES_SH_SZ|2026-09-24T02:20:00.000Z',
          tradingDate: '2026-09-24',
          sampledAt: new Date('2026-09-24T02:20:00.000Z'),
        });
        await repos.marketSnapshotBatch.publish(earlier);
        await repos.marketSnapshotBatch.publish(later);
        await expect(
          repos.marketSnapshotBatch.findNearestAt({
            tradingDate: '2026-09-24',
            sampledAt: new Date('2026-09-24T02:16:00.000Z'),
            toleranceMs: 5 * 60_000,
          }),
        ).resolves.toEqual(later);
      });
    });

    describe('ChatRepository', () => {
      it('并发首次插入只保存一个消息，重复或跨会话 ID 不覆盖原文', async () => {
        await repos.chat.saveSession(makeChatSession('c1'));
        await repos.chat.saveSession(makeChatSession('c2'));
        const first = makeChatMessage('same-id', 'c1', {
          parts: [{ type: 'text', text: 'first' }],
          createdAt: T1,
        });
        const second = { ...first, parts: [{ type: 'text', text: 'second' }], createdAt: T2 };
        const results = await Promise.all([
          repos.chat.insertMessageIfAbsent(first),
          repos.chat.insertMessageIfAbsent(second),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        const saved = results[0] ? first : second;
        expect(await repos.chat.findMessageById('c1', 'same-id')).toEqual(saved);
        expect(await repos.chat.insertMessageIfAbsent(saved)).toBe(false);
        expect(await repos.chat.insertMessageIfAbsent({ ...second, sessionId: 'c2' })).toBe(false);
        expect(await repos.chat.findMessageById('c1', 'same-id')).toEqual(saved);
        expect(await repos.chat.listMessages('c2')).toEqual([]);
      });

      it('会话归属由 tool 层校验：session 不存在时两种实现同样写入并可读回', async () => {
        await repos.chat.saveMessage(makeChatMessage('orphan-1', 'missing-session'));
        expect(
          await repos.chat.insertMessageIfAbsent(makeChatMessage('orphan-2', 'missing-session')),
        ).toBe(true);
        expect((await repos.chat.listMessages('missing-session')).map((item) => item.id)).toEqual([
          'orphan-1',
          'orphan-2',
        ]);
      });

      it('同一毫秒的消息按二进制 ID 顺序截取，memory 与 SQLite 一致', async () => {
        await repos.chat.saveSession(makeChatSession('c1'));
        for (const id of ['a', 'B', '_a', 'Za']) {
          await repos.chat.saveMessage(makeChatMessage(id, 'c1', { createdAt: T1 }));
        }
        expect((await repos.chat.listMessages('c1')).map((message) => message.id)).toEqual([
          'B',
          'Za',
          '_a',
          'a',
        ]);
        expect((await repos.chat.listMessages('c1', 2)).map((message) => message.id)).toEqual([
          '_a',
          'a',
        ]);
      });

      it('截取最近消息并稳定排序；草案状态原子更新不会移动消息', async () => {
        await repos.chat.saveSession(makeChatSession('c1'));
        const first = makeChatMessage('m1', 'c1', { createdAt: T1 });
        const second = makeChatMessage('m2', 'c1', { createdAt: T2 });
        await repos.chat.saveMessage(first);
        await repos.chat.saveMessage(second);
        await repos.chat.saveMessage(makeChatMessage('m3', 'c1', { createdAt: T3 }));
        expect((await repos.chat.listMessages('c1', 2)).map((message) => message.id)).toEqual([
          'm2',
          'm3',
        ]);
        expect(await repos.chat.findMessageById('other', 'm2')).toBeNull();
        const changed = {
          ...second,
          parts: [...second.parts, { type: 'data-test', data: 'claimed' }],
        };
        const claims = await Promise.all([
          repos.chat.compareAndSetMessageParts(changed, second.parts),
          repos.chat.compareAndSetMessageParts(changed, second.parts),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(await repos.chat.findMessageById('c1', 'm2')).toEqual(changed);
        expect((await repos.chat.listMessages('c1')).map((message) => message.id)).toEqual([
          'm1',
          'm2',
          'm3',
        ]);
        expect(
          await repos.chat.compareAndSetMessageParts(
            { ...changed, sessionId: 'other' },
            changed.parts,
          ),
        ).toBe(false);
        await repos.chat.saveSession(makeChatSession('other'));
        await expect(repos.chat.saveMessage({ ...changed, sessionId: 'other' })).rejects.toThrow(
          InvariantError,
        );
      });

      it('会话按账户隔离并按 updatedAt 倒序', async () => {
        await repos.chat.saveSession(makeChatSession('c1', { updatedAt: T1 }));
        await repos.chat.saveSession(makeChatSession('c2', { updatedAt: T2 }));
        await repos.chat.saveSession(
          makeChatSession('other', { accountId: 'account-2', updatedAt: T3 }),
        );
        expect((await repos.chat.listSessions('account-1')).map((item) => item.id)).toEqual([
          'c2',
          'c1',
        ]);
      });

      it('消息按时间升序，删除会话级联删除消息', async () => {
        await repos.chat.saveSession(makeChatSession('c1'));
        await repos.chat.saveMessage(makeChatMessage('m2', 'c1', { createdAt: T2 }));
        await repos.chat.saveMessage(
          makeChatMessage('m1', 'c1', {
            role: 'assistant',
            parts: [
              { type: 'text', text: '回答' },
              { type: 'tool-fetch_quote', toolCallId: 'call-1', state: 'output-available' },
            ],
            createdAt: T1,
          }),
        );
        expect((await repos.chat.listMessages('c1')).map((item) => item.id)).toEqual(['m1', 'm2']);
        await repos.chat.removeSession('c1');
        expect(await repos.chat.findSessionById('c1')).toBeNull();
        expect(await repos.chat.listMessages('c1')).toEqual([]);
      });
    });
  });
};
