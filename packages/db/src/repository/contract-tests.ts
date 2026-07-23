import {
  type Account,
  type Advice,
  type AdviceOutcome,
  type DailyBar,
  type GroupMemberSnapshot,
  type Holding,
  InvariantError,
  money,
  type Notification,
  type Quote,
  quantity,
  type RepositoryRegistry,
  STANDARD_DISCLAIMERS,
  type Stock,
  type StockGroup,
  type StockPool,
  stockCode,
  type Tactic,
  type TacticSignal,
  type Trade,
  type WatchRun,
  type WatchTrigger,
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

export const makeAccount = (id: string, overrides: Partial<Account> = {}): Account => ({
  id,
  name: `账户-${id}`,
  kind: 'real',
  currency: 'CNY',
  initialCapital: money(1_000_000),
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
  adjFactor: 1.0,
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

export const makeTactic = (id: string, overrides: Partial<Tactic> = {}): Tactic => ({
  id,
  name: `战法-${id}`,
  tag: 'momentum',
  description: 'fixture tactic description',
  triggerWhen: 'true',
  scoreExpression: '50',
  direction: 'bullish',
  evidenceTemplate: ['fixture-evidence'],
  source: 'builtin',
  definedAt: T0,
  ...overrides,
});

export const makeTacticSignal = (
  tacticId: string,
  stockId: string,
  overrides: Partial<TacticSignal> = {},
): TacticSignal => ({
  tacticId,
  tacticName: `战法-${tacticId}`,
  tacticTag: 'momentum',
  stockId,
  ts: T1,
  score: 75,
  direction: 'bullish',
  evidence: ['fixture-evidence'],
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

export const makeStockPool = (id: string, overrides: Partial<StockPool> = {}): StockPool => ({
  id,
  name: `池-${id}`,
  groupId: 'grp-1',
  rules: [{ kind: 'price-change', pct: 0.05 }],
  cooldownMinutes: 30,
  enabled: true,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

export const makeStockGroup = (id: string, overrides: Partial<StockGroup> = {}): StockGroup => ({
  id,
  name: `分组-${id}`,
  resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
  refreshPolicy: 'daily',
  enabled: true,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

export const makeGroupMemberSnapshot = (
  id: string,
  overrides: Partial<GroupMemberSnapshot> = {},
): GroupMemberSnapshot => ({
  id,
  groupId: 'grp-1',
  stockId: '002594.SZ',
  refreshId: 'rf-1',
  reason: 'fixture reason',
  createdAt: T1,
  ...overrides,
});

export const makeWatchTrigger = (
  id: string,
  overrides: Partial<WatchTrigger> = {},
): WatchTrigger => ({
  id,
  poolId: 'pool-1',
  stockId: '002594.SZ',
  ruleKind: 'price-change',
  direction: 'watch',
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
            tacticSignals: [
              {
                tacticId: 'tac-1',
                tacticName: '放量突破',
                tacticTag: 'momentum' as const,
                stockId: 'stk-1',
                ts: T3,
                score: 80,
                direction: 'bullish' as const,
                evidence: ['放量突破'],
              },
            ],
            llmReasoning: '原始推理文本',
            dataAsOf: T3,
          },
        });
        await repos.advice.save(advice);
        const got = await repos.advice.findById('adv-1');
        expect(got).toEqual(advice);
        expect(got?.basedOn.dataAsOf).toBeInstanceOf(Date);
        expect(got?.basedOn.quotes?.['stk-1']?.ts).toBeInstanceOf(Date);
        expect(got?.basedOn.tacticSignals?.[0]?.ts).toBeInstanceOf(Date);
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

      it('save 同 (stockId, ts) 为 upsert', async () => {
        await repos.quote.save(makeQuote('stk-1', T2, { close: money(10) }));
        await repos.quote.save(makeQuote('stk-1', T2, { close: money(99) }));
        expect((await repos.quote.latestByStock('stk-1'))?.close).toBe(99);
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

    describe('TacticRepository', () => {
      it('save + findById 往返一致', async () => {
        const t = makeTactic('momentum-1');
        await repos.tactic.save(t);
        expect(await repos.tactic.findById('momentum-1')).toEqual(t);
        expect(await repos.tactic.findById('missing')).toBeNull();
      });

      it('list 默认按 id 升序；tag / source 过滤（只关心 fixture 添加的）', async () => {
        await repos.tactic.save(makeTactic('t-2', { tag: 'volume' }));
        await repos.tactic.save(makeTactic('t-1', { tag: 'momentum' }));
        await repos.tactic.save(
          makeTactic('u-1', { tag: 'risk', direction: 'bearish', source: 'user' }),
        );
        // v0.3 起 in-memory repos 默认灌入 5 个内置战法（不参与本测试断言）；
        // 这里只验证 t-/u- 前缀的相对顺序与过滤。
        const ids = (await repos.tactic.list())
          .map((t) => t.id)
          .filter((id) => id.startsWith('t-') || id.startsWith('u-'));
        expect(ids).toEqual(['t-1', 't-2', 'u-1']);
        const momentumIds = (await repos.tactic.list({ tag: 'momentum' }))
          .map((t) => t.id)
          .filter((id) => id.startsWith('t-') || id.startsWith('u-'));
        expect(momentumIds).toEqual(['t-1']);
        const builtinIds = (await repos.tactic.list({ source: 'builtin' }))
          .map((t) => t.id)
          .filter((id) => id.startsWith('t-') || id.startsWith('u-'));
        expect(builtinIds).toEqual(['t-1', 't-2']);
      });

      it('违反不变量时拒绝（risk + bullish 冲突）', async () => {
        await expect(
          repos.tactic.save(makeTactic('bad', { tag: 'risk', direction: 'bullish' })),
        ).rejects.toThrow();
      });

      it('saveSignal + signalsByTactic 按 ts 倒序', async () => {
        await repos.tactic.saveSignal(makeTacticSignal('m1', '002594.SZ', { ts: T1 }));
        await repos.tactic.saveSignal(makeTacticSignal('m1', '600519.SH', { ts: T2 }));
        await repos.tactic.saveSignal(makeTacticSignal('v1', '002594.SZ', { ts: T3 }));
        expect((await repos.tactic.signalsByTactic('m1')).map((s) => s.ts.getTime())).toEqual([
          T2.getTime(),
          T1.getTime(),
        ]);
        expect((await repos.tactic.signalsByStock('002594.SZ')).map((s) => s.tacticId)).toEqual([
          'v1',
          'm1',
        ]);
      });

      it('saveSignal 同 (tacticId, stockId, ts) 为 upsert', async () => {
        await repos.tactic.saveSignal(makeTacticSignal('m1', '002594.SZ', { ts: T1, score: 50 }));
        await repos.tactic.saveSignal(makeTacticSignal('m1', '002594.SZ', { ts: T1, score: 80 }));
        const sigs = await repos.tactic.signalsByTactic('m1');
        expect(sigs[0]?.score).toBe(80);
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

    describe('StockPoolRepository', () => {
      it('save + findById 往返一致（含可选 description）', async () => {
        const p = makeStockPool('pool-1', { description: 'd' });
        await repos.stockPool.save(p);
        expect(await repos.stockPool.findById('pool-1')).toEqual(p);
        expect(await repos.stockPool.findById('missing')).toBeNull();
      });

      it('list 默认全部；enabledOnly=true 仅 enabled', async () => {
        await repos.stockPool.save(makeStockPool('p-a', { enabled: true }));
        await repos.stockPool.save(makeStockPool('p-b', { enabled: false }));
        const all = (await repos.stockPool.list()).map((p) => p.id);
        expect(all).toEqual(['p-a', 'p-b']);
        const enabledOnly = (await repos.stockPool.list(true)).map((p) => p.id);
        expect(enabledOnly).toEqual(['p-a']);
      });

      it('update（save 同 id）覆盖字段', async () => {
        await repos.stockPool.save(makeStockPool('p-x', { name: 'old', enabled: true }));
        await repos.stockPool.save(
          makeStockPool('p-x', { name: 'new', enabled: false, updatedAt: T3 }),
        );
        const got = await repos.stockPool.findById('p-x');
        expect(got?.name).toBe('new');
        expect(got?.enabled).toBe(false);
      });

      it('remove 后 findById=null', async () => {
        await repos.stockPool.save(makeStockPool('p-z'));
        await repos.stockPool.remove('p-z');
        expect(await repos.stockPool.findById('p-z')).toBeNull();
      });

      it('违反不变量时拒绝（rules 为空）', async () => {
        await expect(repos.stockPool.save(makeStockPool('bad', { rules: [] }))).rejects.toThrow();
      });
    });

    describe('StockGroupRepository', () => {
      it('save + findById 往返一致（含可选 description + resolver JSON）', async () => {
        const g = makeStockGroup('grp-1', {
          description: 'd',
          resolver: { kind: 'formula', tacticId: 'breakout-volume', lookbackDays: 5, minScore: 60 },
        });
        await repos.stockGroup.save(g);
        expect(await repos.stockGroup.findById('grp-1')).toEqual(g);
        expect(await repos.stockGroup.findById('missing')).toBeNull();
      });

      it('llm resolver（maxMembers / model）往返一致', async () => {
        const g = makeStockGroup('grp-llm', {
          resolver: { kind: 'llm', prompt: '选出当前龙头', maxMembers: 20, model: 'gpt-x' },
        });
        await repos.stockGroup.save(g);
        expect(await repos.stockGroup.findById('grp-llm')).toEqual(g);
      });

      it('list 默认全部（按 id 升序）；enabledOnly=true 仅 enabled', async () => {
        await repos.stockGroup.save(makeStockGroup('g-b', { enabled: false }));
        await repos.stockGroup.save(makeStockGroup('g-a', { enabled: true }));
        expect((await repos.stockGroup.list()).map((g) => g.id)).toEqual(['g-a', 'g-b']);
        expect((await repos.stockGroup.list(true)).map((g) => g.id)).toEqual(['g-a']);
      });

      it('save 同 id 为 upsert；remove 生效', async () => {
        await repos.stockGroup.save(makeStockGroup('g-x', { name: 'old', enabled: true }));
        await repos.stockGroup.save(
          makeStockGroup('g-x', { name: 'new', enabled: false, updatedAt: T3 }),
        );
        const got = await repos.stockGroup.findById('g-x');
        expect(got?.name).toBe('new');
        expect(got?.enabled).toBe(false);
        await repos.stockGroup.remove('g-x');
        expect(await repos.stockGroup.findById('g-x')).toBeNull();
      });

      it('违反不变量时拒绝（updatedAt < createdAt）', async () => {
        await expect(
          repos.stockGroup.save(makeStockGroup('bad', { createdAt: T3, updatedAt: T0 })),
        ).rejects.toThrow(InvariantError);
      });
    });

    describe('GroupMemberRepository', () => {
      it('空分组：currentMembers=[]，latestRefreshId=null', async () => {
        expect(await repos.groupMember.currentMembers('grp-1')).toEqual([]);
        expect(await repos.groupMember.latestRefreshId('grp-1')).toBeNull();
      });

      it('saveBatch + currentMembers 只返回最新 refreshId 那一批', async () => {
        await repos.groupMember.saveBatch([
          makeGroupMemberSnapshot('s-1', {
            refreshId: 'rf-1',
            stockId: '002594.SZ',
            createdAt: T1,
          }),
          makeGroupMemberSnapshot('s-2', {
            refreshId: 'rf-1',
            stockId: '600519.SH',
            createdAt: T1,
          }),
        ]);
        await repos.groupMember.saveBatch([
          makeGroupMemberSnapshot('s-3', {
            refreshId: 'rf-2',
            stockId: '300750.SZ',
            createdAt: T2,
          }),
        ]);
        expect(await repos.groupMember.latestRefreshId('grp-1')).toBe('rf-2');
        const current = await repos.groupMember.currentMembers('grp-1');
        expect(current.map((s) => s.id)).toEqual(['s-3']);
      });

      it('currentMembers 按 stockId 升序；跨分组互不可见', async () => {
        await repos.groupMember.saveBatch([
          makeGroupMemberSnapshot('s-1', {
            refreshId: 'rf-1',
            stockId: '600519.SH',
            createdAt: T1,
          }),
          makeGroupMemberSnapshot('s-2', {
            refreshId: 'rf-1',
            stockId: '002594.SZ',
            createdAt: T1,
          }),
          makeGroupMemberSnapshot('s-3', {
            groupId: 'grp-2',
            refreshId: 'rf-1',
            stockId: '00700.HK',
            createdAt: T1,
          }),
        ]);
        expect((await repos.groupMember.currentMembers('grp-1')).map((s) => s.stockId)).toEqual([
          '002594.SZ',
          '600519.SH',
        ]);
        expect((await repos.groupMember.currentMembers('grp-2')).map((s) => s.stockId)).toEqual([
          '00700.HK',
        ]);
      });

      it('listHistory 按 createdAt 倒序返回全部批次；since 过滤（≥）', async () => {
        await repos.groupMember.saveBatch([
          makeGroupMemberSnapshot('s-1', { refreshId: 'rf-1', createdAt: T1 }),
          makeGroupMemberSnapshot('s-2', { refreshId: 'rf-2', createdAt: T2 }),
          makeGroupMemberSnapshot('s-3', { refreshId: 'rf-3', createdAt: T3 }),
        ]);
        expect((await repos.groupMember.listHistory('grp-1')).map((s) => s.id)).toEqual([
          's-3',
          's-2',
          's-1',
        ]);
        expect((await repos.groupMember.listHistory('grp-1', T2)).map((s) => s.id)).toEqual([
          's-3',
          's-2',
        ]);
      });

      it('saveBatch 同 id 重复写入不报错（幂等）', async () => {
        const s = makeGroupMemberSnapshot('s-1');
        await repos.groupMember.saveBatch([s]);
        await repos.groupMember.saveBatch([s]);
        expect(await repos.groupMember.currentMembers('grp-1')).toHaveLength(1);
      });
    });

    describe('WatchTriggerRepository', () => {
      it('save + findById 往返一致', async () => {
        const t = makeWatchTrigger('tr-1');
        await repos.watchTrigger.save(t);
        expect(await repos.watchTrigger.findById('tr-1')).toEqual(t);
        expect(await repos.watchTrigger.findById('missing')).toBeNull();
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

      it('lastForKey 找 (poolId, stockId, ruleKind) 维度最近一条', async () => {
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-old', {
            createdAt: T1,
            poolId: 'p1',
            stockId: 's1',
            ruleKind: 'price-change',
          }),
        );
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-new', {
            createdAt: T3,
            poolId: 'p1',
            stockId: 's1',
            ruleKind: 'price-change',
          }),
        );
        // 不同 ruleKind → 不命中
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-other', {
            createdAt: T3,
            poolId: 'p1',
            stockId: 's1',
            ruleKind: 'tactic',
          }),
        );
        const hit = await repos.watchTrigger.lastForKey(
          { poolId: 'p1', stockId: 's1', ruleKind: 'price-change' },
          FAR_PAST,
        );
        expect(hit?.id).toBe('tr-new');
        const miss = await repos.watchTrigger.lastForKey(
          { poolId: 'p1', stockId: 's1', ruleKind: 'cost-threshold' },
          FAR_PAST,
        );
        expect(miss).toBeNull();
        // since 过滤：T1 之前的应被剔除
        const cutoff = await repos.watchTrigger.lastForKey(
          { poolId: 'p1', stockId: 's1', ruleKind: 'price-change' },
          T2,
        );
        expect(cutoff?.id).toBe('tr-new');
      });

      it('lastForKey 仅返回真实通知记录，试跑审计不占 cooldown', async () => {
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-notified', {
            createdAt: T1,
            poolId: 'p1',
            stockId: 's1',
            ruleKind: 'price-change',
            notified: true,
          }),
        );
        await repos.watchTrigger.save(
          makeWatchTrigger('tr-dry-run', {
            createdAt: T3,
            poolId: 'p1',
            stockId: 's1',
            ruleKind: 'price-change',
            notified: false,
          }),
        );
        const hit = await repos.watchTrigger.lastForKey(
          { poolId: 'p1', stockId: 's1', ruleKind: 'price-change' },
          FAR_PAST,
        );
        expect(hit?.id).toBe('tr-notified');
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
  });
};
