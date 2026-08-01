import {
  type Account,
  type Advice,
  type AdviceOutcome,
  type AlertPlan,
  type ChatMessage,
  type ChatSession,
  type DailyBar,
  type Holding,
  InvariantError,
  money,
  type Notification,
  type Quote,
  quantity,
  type Report,
  type RepositoryRegistry,
  type ResearchNote,
  STANDARD_DISCLAIMERS,
  type Stock,
  type StockEvent,
  type StockUniverseEntry,
  type Strategy,
  type StrategyResult,
  type StrategyRun,
  type StrategySignal,
  type StrategyVersion,
  stockCode,
  strategyDefinitionHash,
  type Trade,
  type Watchlist,
  type WatchlistMemberSource,
  type WatchlistSyncRun,
  type WatchRun,
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
  createdAt: T0,
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

export const makeStrategyRun = (id: string, overrides: Partial<StrategyRun> = {}): StrategyRun => ({
  id,
  strategyId: 'strategy-1',
  strategyVersionId: 'strategy-1-v1',
  mode: 'scan',
  coverage: 'CN_A_SHARES_SH_SZ',
  dataAsOf: T1,
  startedAt: T1,
  finishedAt: T2,
  status: 'complete',
  inputSnapshot: { fixture: true },
  providerStatuses: [],
  summary: { selected: 1 },
  ...overrides,
});

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

export const makeWatchRun = (id: string, overrides: Partial<WatchRun> = {}): WatchRun => ({
  id,
  mode: 'daemon',
  status: 'succeeded',
  startedAt: T1,
  finishedAt: T2,
  evaluatedPools: 1,
  evaluatedStocks: 6,
  triggered: 2,
  notified: 1,
  suppressedByCooldown: 1,
  suppressedByDailyLimit: 0,
  notifyFailed: 0,
  ...overrides,
});

export const makeResearchNote = (
  id: string,
  overrides: Partial<ResearchNote> = {},
): ResearchNote => ({
  id,
  stockId: 'stk-1',
  kind: 'note',
  content: `笔记内容-${id}`,
  active: false,
  tags: [],
  createdAt: T1,
  updatedAt: T1,
  ...overrides,
});

export const makeStockEvent = (id: string, overrides: Partial<StockEvent> = {}): StockEvent => ({
  id,
  stockId: 'stk-1',
  kind: 'earnings',
  title: `事件-${id}`,
  occursAt: T2,
  allDay: true,
  importance: 'important',
  status: 'scheduled',
  source: 'manual',
  stale: false,
  remindBeforeDays: [],
  createdAt: T1,
  updatedAt: T1,
  ...overrides,
});

export const makeWorkflowRun = (id: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  workflowName: 'sync-stock-events',
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

      it('listByAccount 按 executedAt 升序', async () => {
        await repos.trade.save(makeTrade('t-2', { executedAt: T3 }));
        await repos.trade.save(makeTrade('t-1', { executedAt: T1 }));
        await repos.trade.save(makeTrade('t-9', { accountId: 'acc-2', executedAt: T0 }));
        const list = await repos.trade.listByAccount('acc-1');
        expect(list.map((t) => t.id)).toEqual(['t-1', 't-2']);
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
          outcome: 'followed',
          pnl: money(123.4567),
          benchmarkPnl: money(50),
          recordedAt: T3,
        };
        await repos.advice.recordOutcome('adv-1', outcome);
        expect(await handle.readOutcome('adv-1')).toEqual(outcome);

        const updated: AdviceOutcome = { adviceId: 'adv-1', outcome: 'ignored', recordedAt: T3 };
        await repos.advice.recordOutcome('adv-1', updated);
        expect(await handle.readOutcome('adv-1')).toEqual(updated);
      });

      it('recordOutcome 的 adviceId 不一致时拒绝', async () => {
        const outcome: AdviceOutcome = { adviceId: 'adv-x', outcome: 'ignored', recordedAt: T3 };
        await expect(repos.advice.recordOutcome('adv-y', outcome)).rejects.toThrow(InvariantError);
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
    });

    describe('StrategyRepository', () => {
      it('Strategy 与版本往返、过滤和版本排序一致', async () => {
        await repos.strategy.save(makeStrategy('strategy-2', { owner: 'builtin' }));
        await repos.strategy.save(makeStrategy('strategy-1'));
        await repos.strategy.saveVersion(makeStrategyVersion('strategy-1', 1));
        await repos.strategy.saveVersion(makeStrategyVersion('strategy-1', 2));
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

      it('activateVersion 只接受同 Strategy 的 published valid version', async () => {
        await repos.strategy.save(makeStrategy('strategy-1'));
        const version = makeStrategyVersion('strategy-1');
        await repos.strategy.saveVersion(version);
        await repos.strategy.activateVersion('strategy-1', version.id, T2);
        expect(await repos.strategy.findById('strategy-1')).toEqual(
          makeStrategy('strategy-1', {
            status: 'active',
            currentVersionId: version.id,
            updatedAt: T2,
          }),
        );

        await repos.strategy.save(makeStrategy('strategy-2'));
        await expect(repos.strategy.activateVersion('strategy-2', version.id, T2)).rejects.toThrow(
          InvariantError,
        );
      });

      it('publishVersion 原子发布 valid version 并切换 currentVersion', async () => {
        await repos.strategy.save(makeStrategy('strategy-1'));
        const publishedFixture = makeStrategyVersion('strategy-1');
        const { publishedAt: _publishedAt, ...draftVersion } = publishedFixture;
        await repos.strategy.saveVersion(draftVersion);
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

      it('published version definition 不可变，(strategyId, version) 唯一', async () => {
        await repos.strategy.save(makeStrategy('strategy-1'));
        const version = makeStrategyVersion('strategy-1');
        await repos.strategy.saveVersion(version);
        const changedDefinition = {
          ...version.definition,
          metadata: { style: 'changed' },
        };
        await expect(
          repos.strategy.saveVersion({
            ...version,
            definition: changedDefinition,
            definitionHash: strategyDefinitionHash(changedDefinition),
          }),
        ).rejects.toThrow(InvariantError);
        await expect(
          repos.strategy.saveVersion({
            ...makeStrategyVersion('strategy-1'),
            id: 'another-id',
          }),
        ).rejects.toThrow(InvariantError);
      });
    });

    describe('StrategyRunRepository', () => {
      beforeEach(async () => {
        await repos.strategy.save(makeStrategy('strategy-1'));
        await repos.strategy.saveVersion(makeStrategyVersion('strategy-1'));
        await repos.strategy.activateVersion('strategy-1', 'strategy-1-v1', T1);
      });

      it('run 往返和过滤排序一致', async () => {
        await repos.strategyRun.saveRun(
          makeStrategyRun('run-1', { startedAt: T1, finishedAt: T2 }),
        );
        await repos.strategyRun.saveRun(
          makeStrategyRun('run-2', { startedAt: T2, finishedAt: T3 }),
        );
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
      });

      it('active Strategy 可运行显式 pinned 的历史 published valid version', async () => {
        const version2 = makeStrategyVersion('strategy-1', 2, {
          id: 'strategy-1-v2',
          createdAt: T2,
          publishedAt: T2,
        });
        await repos.strategy.saveVersion(version2);
        await repos.strategy.activateVersion('strategy-1', version2.id, T2);
        const pinned = makeStrategyRun('run-pinned-v1', {
          strategyVersionId: 'strategy-1-v1',
        });
        await repos.strategyRun.commitRun({ run: pinned, results: [], signals: [] });
        expect(await repos.strategyRun.findRunById(pinned.id)).toEqual(pinned);
      });

      it('results 按 rank/stock 排序并按 (run, stock) upsert', async () => {
        await repos.strategyRun.saveRun(makeStrategyRun('run-1'));
        await repos.strategyRun.saveResults([
          makeStrategyResult('run-1', '600519.SH', { rank: 2 }),
          makeStrategyResult('run-1', '002594.SZ', { rank: 1 }),
        ]);
        await repos.strategyRun.saveResults([
          makeStrategyResult('run-1', '600519.SH', { rank: 2, score: 90 }),
        ]);
        const results = await repos.strategyRun.listResults('run-1');
        expect(results.map((result) => result.stockId)).toEqual(['002594.SZ', '600519.SH']);
        expect(results[1]?.score).toBe(90);
      });

      it('listResults 无 rank 的结果排在最后', async () => {
        await repos.strategyRun.saveRun(makeStrategyRun('run-1'));
        await repos.strategyRun.saveResults([
          makeStrategyResult('run-1', '600519.SH', { rank: undefined }),
          makeStrategyResult('run-1', '002594.SZ', { rank: 1 }),
        ]);
        const results = await repos.strategyRun.listResults('run-1');
        expect(results.map((result) => result.stockId)).toEqual(['002594.SZ', '600519.SH']);
        expect(results[1]?.rank).toBeUndefined();
      });

      it('saveRun 重复保存只更新运行态列，身份列保持首次值', async () => {
        await repos.strategyRun.saveRun(makeStrategyRun('run-1', { startedAt: T1 }));
        await repos.strategyRun.saveRun(
          makeStrategyRun('run-1', {
            startedAt: T3,
            finishedAt: T3,
            mode: 'backtest',
            status: 'failed',
            summary: undefined,
            error: 'boom',
          }),
        );
        const got = await repos.strategyRun.findRunById('run-1');
        expect(got).toMatchObject({
          id: 'run-1',
          startedAt: T1,
          finishedAt: T3,
          mode: 'scan',
          status: 'failed',
          error: 'boom',
        });
        expect(got?.summary).toBeUndefined();
      });

      it('signals 按目标唯一键幂等并支持 strategy/stock 查询', async () => {
        await repos.strategyRun.saveRun(makeStrategyRun('run-1'));
        const first = makeStrategySignal('signal-1', '600519.SH', { ts: T1 });
        const duplicateIdentity = makeStrategySignal('signal-duplicate', '600519.SH', { ts: T1 });
        const second = makeStrategySignal('signal-2', '002594.SZ', { ts: T2 });
        await repos.strategyRun.saveSignals([first, duplicateIdentity, second]);
        expect(
          (await repos.strategyRun.signalsByStrategy('strategy-1')).map((signal) => signal.id),
        ).toEqual(['signal-2', 'signal-1']);
        expect(await repos.strategyRun.signalsByStock('600519.SH')).toEqual([first]);
      });

      it('signalsByRun 只返回指定运行并保持时间倒序', async () => {
        await repos.strategyRun.saveRun(makeStrategyRun('run-1', { startedAt: T1 }));
        await repos.strategyRun.saveRun(
          makeStrategyRun('run-2', { startedAt: T2, finishedAt: T3 }),
        );
        const older = makeStrategySignal('signal-old', '600519.SH', { runId: 'run-1', ts: T1 });
        const newer = makeStrategySignal('signal-new', '002594.SZ', { runId: 'run-1', ts: T2 });
        const otherRun = makeStrategySignal('signal-other', '300750.SZ', {
          runId: 'run-2',
          ts: T3,
        });
        await repos.strategyRun.saveSignals([older, newer, otherRun]);

        expect((await repos.strategyRun.signalsByRun('run-1')).map((signal) => signal.id)).toEqual([
          'signal-new',
          'signal-old',
        ]);
        expect(await repos.strategyRun.signalsByRun('missing')).toEqual([]);
      });

      it('saveSignals 主键 id 冲突也忽略（与身份唯一索引同语义）', async () => {
        await repos.strategyRun.saveRun(makeStrategyRun('run-1'));
        const first = makeStrategySignal('signal-1', '600519.SH', { ts: T1 });
        const sameIdOtherIdentity = makeStrategySignal('signal-1', '002594.SZ', { ts: T2 });
        await repos.strategyRun.saveSignals([first, sameIdOtherIdentity]);
        expect(await repos.strategyRun.signalsByStrategy('strategy-1')).toEqual([first]);
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

      it('saveSnapshots 按 (syncRunId, stockId) upsert', async () => {
        await repos.watchlistMember.saveSyncRun(makeWatchlistSyncRun('sync-1'));
        const base = {
          syncRunId: 'sync-1',
          stockId: '600519.SH',
          selected: true,
          change: 'entered' as const,
          reason: 'first',
          evidence: [],
        };
        await repos.watchlistMember.saveSnapshots([{ id: 'snap-1', ...base }]);
        await repos.watchlistMember.saveSnapshots([{ id: 'snap-2', ...base, reason: 'updated' }]);
        const snapshots = await repos.watchlistMember.listSnapshots('sync-1');
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]?.reason).toBe('updated');
      });
    });

    describe('NotificationRepository', () => {
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

    describe('WatchRunRepository', () => {
      it('running → succeeded upsert，latest/listRecent 按 startedAt 倒序', async () => {
        await repos.watchRun.save(
          makeWatchRun('run-1', {
            status: 'running',
            startedAt: T1,
            finishedAt: null,
            evaluatedPools: 0,
            evaluatedStocks: 0,
            triggered: 0,
            notified: 0,
            suppressedByCooldown: 0,
          }),
        );
        await repos.watchRun.save(makeWatchRun('run-1', { startedAt: T1, finishedAt: T2 }));
        await repos.watchRun.save(
          makeWatchRun('run-2', {
            startedAt: T3,
            finishedAt: T3,
            triggered: 0,
            notified: 0,
            suppressedByCooldown: 0,
          }),
        );

        expect((await repos.watchRun.findById('run-1'))?.status).toBe('succeeded');
        expect((await repos.watchRun.latest())?.id).toBe('run-2');
        expect((await repos.watchRun.listRecent(2)).map((run) => run.id)).toEqual([
          'run-2',
          'run-1',
        ]);
      });

      it('failed 缺 error 时拒绝', async () => {
        await expect(
          repos.watchRun.save(makeWatchRun('run-bad', { status: 'failed', error: undefined })),
        ).rejects.toThrow();
      });
    });

    describe('ResearchNoteRepository', () => {
      it('save + findById 往返一致；listByStock 按 createdAt 倒序 + kind/since 过滤', async () => {
        await repos.researchNote.save(makeResearchNote('n1', { createdAt: T1, kind: 'note' }));
        await repos.researchNote.save(
          makeResearchNote('n2', { createdAt: T2, updatedAt: T2, kind: 'thesis', active: true }),
        );
        expect(await repos.researchNote.findById('n1')).toEqual(
          makeResearchNote('n1', { createdAt: T1, kind: 'note' }),
        );
        const all = await repos.researchNote.listByStock('stk-1');
        expect(all.map((n) => n.id)).toEqual(['n2', 'n1']);
        const theses = await repos.researchNote.listByStock('stk-1', { kind: 'thesis' });
        expect(theses.map((n) => n.id)).toEqual(['n2']);
        const sinceT2 = await repos.researchNote.listByStock('stk-1', { since: T2 });
        expect(sinceT2.map((n) => n.id)).toEqual(['n2']);
      });

      it('save 新 active thesis 停用同股旧 active thesis（事务）', async () => {
        await repos.researchNote.save(
          makeResearchNote('t1', { kind: 'thesis', active: true, createdAt: T1 }),
        );
        await repos.researchNote.save(
          makeResearchNote('t2', {
            kind: 'thesis',
            active: true,
            supersedesId: 't1',
            createdAt: T2,
            updatedAt: T2,
          }),
        );
        expect((await repos.researchNote.findById('t1'))?.active).toBe(false);
        expect((await repos.researchNote.findById('t2'))?.active).toBe(true);
        const active = await repos.researchNote.listByStock('stk-1', {
          kind: 'thesis',
          activeOnly: true,
        });
        expect(active.map((n) => n.id)).toEqual(['t2']);
      });

      it('deactivateTheses 停用全部 active thesis 并返回条数', async () => {
        await repos.researchNote.save(
          makeResearchNote('t1', { kind: 'thesis', active: true, createdAt: T1 }),
        );
        const count = await repos.researchNote.deactivateTheses('stk-1');
        expect(count).toBe(1);
        expect((await repos.researchNote.findById('t1'))?.active).toBe(false);
      });

      it('listStockIdsWithNotes 返回去重排序后的研究股票集合', async () => {
        await repos.researchNote.save(makeResearchNote('n1', { stockId: 'stk-2' }));
        await repos.researchNote.save(makeResearchNote('n2', { stockId: 'stk-1' }));
        await repos.researchNote.save(makeResearchNote('n3', { stockId: 'stk-2' }));
        expect(await repos.researchNote.listStockIdsWithNotes()).toEqual(['stk-1', 'stk-2']);
      });

      it('source-summary 缺 sourceUrl/fetchedAt 时拒绝', async () => {
        await expect(
          repos.researchNote.save(
            makeResearchNote('bad', { kind: 'source-summary', content: 'x' }),
          ),
        ).rejects.toThrow();
      });
    });

    describe('StockEventRepository', () => {
      it('upsertByExternal 幂等：同 (provider, externalId) 更新不重复插入', async () => {
        const first = makeStockEvent('e1', {
          source: 'external',
          provider: 'p',
          externalId: 'x1',
          title: '一季报',
        });
        expect(await repos.stockEvent.upsertByExternal(first)).toBe('inserted');
        const second = makeStockEvent('e2', {
          source: 'external',
          provider: 'p',
          externalId: 'x1',
          title: '一季报（改期）',
          occursAt: T3,
        });
        expect(await repos.stockEvent.upsertByExternal(second)).toBe('updated');
        const all = await repos.stockEvent.list({ stockId: 'stk-1' });
        expect(all.length).toBe(1);
        expect(all[0]?.title).toBe('一季报（改期）');
        expect(all[0]?.occursAt.getTime()).toBe(T3.getTime());
      });

      it('listUpcoming 过滤 status/window/kinds/minImportance', async () => {
        await repos.stockEvent.save(
          makeStockEvent('u1', { occursAt: T2, importance: 'normal', kind: 'earnings' }),
        );
        await repos.stockEvent.save(
          makeStockEvent('u2', { occursAt: T3, importance: 'urgent', kind: 'unlock' }),
        );
        await repos.stockEvent.save(
          makeStockEvent('u3', { occursAt: T2, status: 'cancelled', importance: 'urgent' }),
        );
        const win = await repos.stockEvent.listUpcoming('stk-1', T1, T3, {
          minImportance: 'important',
        });
        expect(win.map((e) => e.id)).toEqual(['u2']);
        const byKind = await repos.stockEvent.listUpcoming('stk-1', T1, T3, {
          kinds: ['earnings'],
        });
        expect(byKind.map((e) => e.id)).toEqual(['u1']);
      });

      it('markStaleByProvider 标记该源全部事件为 stale', async () => {
        await repos.stockEvent.save(
          makeStockEvent('s1', { source: 'external', provider: 'p', externalId: 'a' }),
        );
        await repos.stockEvent.save(
          makeStockEvent('s2', { source: 'external', provider: 'q', externalId: 'b' }),
        );
        expect(await repos.stockEvent.markStaleByProvider('p')).toBe(1);
        expect((await repos.stockEvent.findById('s1'))?.stale).toBe(true);
        expect((await repos.stockEvent.findById('s2'))?.stale).toBe(false);
      });

      it('external 事件缺 provider/externalId 时拒绝', async () => {
        await expect(
          repos.stockEvent.save(makeStockEvent('bad', { source: 'external' })),
        ).rejects.toThrow();
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
            workflowName: 'evaluate-event-rules',
            startedAt: T3,
            finishedAt: T3,
            status: 'partial',
          }),
        );
        expect((await repos.workflowRun.findById('w1'))?.status).toBe('succeeded');
        const recent = await repos.workflowRun.listRecent();
        expect(recent.map((r) => r.id)).toEqual(['w2', 'w1']);
        const byName = await repos.workflowRun.listRecent({ workflowName: 'sync-stock-events' });
        expect(byName.map((r) => r.id)).toEqual(['w1']);
      });

      it('failed 缺 error 时拒绝', async () => {
        await expect(
          repos.workflowRun.save(makeWorkflowRun('w-bad', { status: 'failed', error: undefined })),
        ).rejects.toThrow();
      });
    });

    describe('ReportRepository', () => {
      it('upsertForPeriod 后可按 id 和逻辑周期读取', async () => {
        const saved = await repos.report.upsertForPeriod(makeReport('report-1'));

        expect((await repos.report.findById(saved.id))?.title).toBe('收盘复盘-report-1');
        expect(
          await repos.report.findByPeriod({
            kind: 'closing',
            scopeKey: 'all-accounts',
            periodStart: '2026-07-02',
            periodEnd: '2026-07-02',
          }),
        ).toEqual(saved);
      });

      it('相同逻辑周期重跑保留 id/createdAt，只更新正文与运行引用', async () => {
        await repos.report.upsertForPeriod(makeReport('report-original'));
        const rerun = await repos.report.upsertForPeriod(
          makeReport('report-new-id', {
            title: '重跑后的收盘复盘',
            workflowRunId: 'workflow-run-2',
            generatedAt: T3,
            updatedAt: T3,
          }),
        );

        expect(rerun.id).toBe('report-original');
        expect(rerun.createdAt).toEqual(T2);
        expect(rerun.title).toBe('重跑后的收盘复盘');
        expect(rerun.workflowRunId).toBe('workflow-run-2');
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
    });

    describe('ChatRepository', () => {
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
