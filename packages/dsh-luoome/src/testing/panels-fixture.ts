// M4 浏览器/安装验收共用的合成事实 fixture。
//
// 该脚本由 Bun 运行、用 `@luoome/db`（bun:sqlite）写临时 SQLite；随后 DSH Node 进程用
// `@luoome/db/node`（node:sqlite）打开同一个事实库，验证浏览器面板展示与真实 ToolResult/DB
// 一致。数据全部为合成：账户/持仓/建议/策略/运行/决策复盘，不含真实个人数据，不联网。
//
// 用法（仅供 infra/dsh/panels-browser-acceptance.ts 调用）：
//   bun --no-env-file packages/dsh-luoome/src/testing/panels-fixture.ts seed <home> '<ownerJson>'
//   bun --no-env-file packages/dsh-luoome/src/testing/panels-fixture.ts dump <home> '<ownerJson>'
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FakeMarketAdapter } from '@luoome/adapters/testing';
import {
  type Account,
  type Advice,
  type Holding,
  STANDARD_DISCLAIMERS,
  type Stock,
  type StrategyDslV1,
  type StrategyRun,
  strategyDefinitionHash,
  type ToolContext,
} from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import {
  buildContext,
  createWatchlistTool,
  getDecisionReviewContextTool,
  saveDecisionReviewTool,
  setStrategyScheduleTool,
  subscribeStrategyToWatchlistTool,
} from '@luoome/tools';
import { RESEARCH_FIXTURE, seedResearchFixture } from './research-fixture.js';

export interface PanelsFixtureOwner {
  readonly userId: string;
  readonly accountId: string;
}

const STOCK: Stock = Object.freeze({
  id: '600519.SH',
  code: '600519' as Stock['code'],
  exchange: 'SH',
  name: '隔离验收贵州茅台',
});
const STRATEGY_ID = 'strategy-early-breakout-20260809';
const STRATEGY_VERSION_ID = 'strategy-early-breakout-20260809-definition-current';
const RUN_VERSION_ID = 'strategy-early-breakout-20260809-definition-previous';
const RUN_ID = 'strategy-run-browser-published';
const SECOND_STRATEGY_ID = 'strategy-pullback-browser';
const ADVICE_ID = 'browser-advice-watch';
const DECISION_NOTE = '浏览器验收：用户明确回填跟随';
const ADVICE_PREMISE = '浏览器验收：等待量能确认后再判断方向';
const STRATEGY_NAME = '浏览器验收策略';
const WATCHLIST_ID = 'watchlist-browser-strategy';

export const PANELS_FIXTURE = Object.freeze({
  stock: STOCK,
  strategyId: STRATEGY_ID,
  versionId: STRATEGY_VERSION_ID,
  runId: RUN_ID,
  adviceId: ADVICE_ID,
  decisionNote: DECISION_NOTE,
  advicePremise: ADVICE_PREMISE,
  strategyName: STRATEGY_NAME,
  secondStrategyId: SECOND_STRATEGY_ID,
  secondStrategyName: '尚未运行的策略',
  watchlistId: WATCHLIST_ID,
  research: RESEARCH_FIXTURE,
});

const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: { horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      { id: 'positive-close', name: '正价格', when: 'quote.close > 0', evidence: ['收盘价'] },
    ],
  },
  scoring: {
    method: 'weighted-sum',
    components: [{ ruleId: 'positive-close', score: '72', weight: 1 }],
    top: 15,
  },
  signals: {
    entry: [
      {
        id: 'entry-price',
        name: '价格确认',
        when: 'quote.close > 1000',
        score: '72',
        direction: 'bullish',
        evidence: ['价格达到门槛'],
      },
    ],
    exit: [
      {
        id: 'exit-price',
        name: '跌破价格门槛',
        when: 'quote.close < 900',
        score: '80',
        direction: 'bearish',
        evidence: ['价格低于门槛'],
      },
    ],
    risk: [
      {
        id: 'risk-volume',
        name: '量能不足',
        when: 'quote.volume < 100000',
        score: '90',
        direction: 'neutral',
        evidence: ['成交量不足'],
      },
    ],
  },
};

/** 写入合成账户、持仓、建议（含用户 outcome）、策略/版本/已发布运行、决策复盘。 */
export const seedPanelsFixture = async (
  home: string,
  owner: PanelsFixtureOwner,
  now = new Date(),
): Promise<Record<string, unknown>> => {
  const { repos, close } = createDrizzleRepos(join(home, 'luoome.db'));
  try {
    const account: Account = {
      id: owner.accountId,
      name: '隔离验收账户（合成数据）',
      kind: 'real',
      currency: 'CNY',
      initialCapital: 1_000_000 as Account['initialCapital'],
      cashBalance: 520_000 as Account['cashBalance'],
      createdAt: now,
    };
    await repos.account.save(account);
    await repos.stock.save(STOCK);
    await repos.quote.save({
      stockId: STOCK.id,
      ts: now,
      observedAt: now,
      fetchedAt: now,
      timestampSource: 'upstream',
      open: 1500 as never,
      high: 1560 as never,
      low: 1490 as never,
      close: 1520 as never,
      prevClose: 1500 as never,
      volume: 1_800_000,
      source: 'browser-acceptance-fixture',
    });
    const holding: Holding = {
      id: 'browser-holding',
      accountId: owner.accountId,
      stockId: STOCK.id,
      quantity: 100,
      availableQuantity: 100,
      avgCost: 1500 as Holding['avgCost'],
      openedAt: new Date(now.getTime() - 30 * 86_400_000),
      closedAt: null,
    };
    await repos.holding.save(holding);

    await repos.strategy.create({
      id: STRATEGY_ID,
      name: STRATEGY_NAME,
      description: `合成策略：验证具体条件、匹配标的与解释。内部引用 ${STRATEGY_ID}`,
      owner: 'user',
      status: 'active',
      currentVersionId: STRATEGY_VERSION_ID,
      createdAt: now,
      updatedAt: now,
    });
    await repos.strategy.createVersion({
      id: RUN_VERSION_ID,
      strategyId: STRATEGY_ID,
      version: 6,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      publishedAt: now,
      createdAt: now,
    });
    await repos.strategy.createVersion({
      id: STRATEGY_VERSION_ID,
      strategyId: STRATEGY_ID,
      version: 7,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      publishedAt: now,
      createdAt: now,
    });
    await repos.strategy.create({
      id: SECOND_STRATEGY_ID,
      name: PANELS_FIXTURE.secondStrategyName,
      description: '验证切换策略与尚未运行的空态。',
      owner: 'user',
      status: 'paused',
      currentVersionId: `${SECOND_STRATEGY_ID}-v1`,
      createdAt: new Date(now.getTime() - 1000),
      updatedAt: new Date(now.getTime() - 1000),
    });
    await repos.strategy.createVersion({
      id: `${SECOND_STRATEGY_ID}-v1`,
      strategyId: SECOND_STRATEGY_ID,
      version: 1,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      publishedAt: now,
      createdAt: now,
    });
    const strategyRun: StrategyRun = {
      id: RUN_ID,
      strategyId: STRATEGY_ID,
      strategyVersionId: RUN_VERSION_ID,
      mode: 'scan',
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf: now,
      startedAt: now,
      finishedAt: now,
      status: 'complete',
      scope: 'operational',
      inputSnapshot: { stockIds: [STOCK.id], universeKind: 'explicit' },
      providerStatuses: [],
      summary: { selected: 1, ruleNearMiss: 0, rankingNearMiss: 0 },
      publication: { status: 'published', reasons: [], decidedAt: now },
    };
    await repos.strategyRun.commitRun({
      run: strategyRun,
      results: [
        {
          runId: strategyRun.id,
          stockId: STOCK.id,
          selected: true,
          score: 72,
          rank: 1,
          evidence: [`quote:${STOCK.id}`, `匹配来源 ${RUN_ID}`],
          ruleEvaluations: [
            {
              schemaVersion: 2,
              scope: 'selection',
              ruleId: 'positive-close',
              status: 'matched',
              expression: 'quote.close > 0',
              inputs: [{ path: 'quote.close', status: 'available', value: 1520 }],
              explanation: { code: 'matched', message: '收盘价 1520 满足价格条件' },
              evidence: ['收盘价已核验'],
            },
          ],
          dataAsOf: now,
        },
      ],
      signals: [],
    });

    const advice: Advice = {
      id: ADVICE_ID,
      subjectKind: 'stock',
      subjectId: STOCK.id,
      stockName: STOCK.name,
      decision: 'watch',
      confidence: 68,
      horizon: 'short',
      reasoning: {
        premise: ADVICE_PREMISE,
        evidence: ['已保存行情：收盘价 1520'],
        counterEvidence: ['缺少成交量扩张证据'],
      },
      risks: ['合成数据不反映真实基本面'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'record_advice',
      basedOn: {
        dataAsOf: now,
        strategy: {
          strategyId: STRATEGY_ID,
          strategyVersionId: RUN_VERSION_ID,
          runId: RUN_ID,
          stockId: STOCK.id,
          accountId: owner.accountId,
          score: 72,
          resultEvidence: [`quote:${STOCK.id}`],
          signalIds: [],
          observationIds: [],
          recommendationTrigger: 'run',
        },
      },
      validFrom: now,
      validUntil: new Date(now.getTime() + 5 * 86_400_000),
      createdAt: now,
      provenance: { generatorKind: 'dsh-chat', evidenceFactIds: [], generatedAt: now },
    };
    await repos.advice.save(advice);
    await repos.advice.recordOutcome(ADVICE_ID, {
      adviceId: ADVICE_ID,
      tradeIds: [],
      outcome: 'followed',
      pnl: 12.5 as never,
      recordedAt: now,
    });

    const ctx: ToolContext = buildContext({
      repos,
      adapters: { market: new FakeMarketAdapter({ clock: () => now }) },
      user: { id: owner.userId, defaultAccountId: owner.accountId },
      identity: { mode: 'local', userId: owner.userId },
      clock: () => now,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    const preview = await getDecisionReviewContextTool.execute(
      { subject: { kind: 'advice', id: ADVICE_ID } },
      ctx,
    );
    if (!preview.ok) throw new Error(`决策复盘预览失败: ${JSON.stringify(preview.error)}`);
    const contextHash = preview.data.context?.contextHash;
    if (typeof contextHash !== 'string') throw new Error('决策复盘预览缺少 contextHash');
    const saved = await saveDecisionReviewTool.execute(
      {
        subject: { kind: 'advice', id: ADVICE_ID },
        requestId: randomUUID(),
        contextHash,
        expectedRevision: 0,
        content: {
          tradeIds: [],
          adviceFeedback: { outcome: 'followed', pnl: 12.5 },
          triggerFeedback: null,
          note: DECISION_NOTE,
        },
        changeNote: DECISION_NOTE,
      },
      ctx,
    );
    if (!saved.ok) throw new Error(`决策复盘写入失败: ${JSON.stringify(saved.error)}`);
    const watchlist = await createWatchlistTool.execute(
      {
        id: WATCHLIST_ID,
        name: '浏览器策略关注',
        kind: 'strategy',
        membershipPolicy: 'mixed',
      },
      ctx,
    );
    if (!watchlist.ok) throw new Error(`Watchlist 写入失败: ${JSON.stringify(watchlist.error)}`);
    const schedule = await setStrategyScheduleTool.execute(
      { strategyId: STRATEGY_ID, cron: '30 16 * * 1-5', enabled: true },
      ctx,
    );
    if (!schedule.ok)
      throw new Error(`StrategySchedule 写入失败: ${JSON.stringify(schedule.error)}`);
    const subscription = await subscribeStrategyToWatchlistTool.execute(
      { strategyId: STRATEGY_ID, watchlistId: WATCHLIST_ID },
      ctx,
    );
    if (!subscription.ok)
      throw new Error(`策略订阅写入失败: ${JSON.stringify(subscription.error)}`);
    await seedResearchFixture(ctx, [STOCK]);
    return { ...PANELS_FIXTURE, owner, database: join(home, 'luoome.db') };
  } finally {
    close();
  }
};

/** 直接读 SQLite 事实库，作为浏览器 DOM / state API 之外的一致性基准。 */
export const dumpPanelsFixture = async (
  home: string,
  owner: PanelsFixtureOwner,
): Promise<Record<string, unknown>> => {
  const { repos, close } = createDrizzleRepos(join(home, 'luoome.db'));
  try {
    const account = await repos.account.findById(owner.accountId);
    const holdings = await repos.holding.listByAccount(owner.accountId);
    const advices = await repos.advice.query({ includeExpired: true });
    const outcomes = await repos.advice.listOutcomes();
    const strategies = await repos.strategy.list();
    const runs = await repos.strategyRun.listRuns({ strategyId: STRATEGY_ID, limit: 10 });
    const schedule = await repos.strategySchedule.findByStrategyId(STRATEGY_ID);
    const subscriptions = await repos.strategyWatchlistSubscription.list({
      strategyId: STRATEGY_ID,
    });
    const reviews = await repos.decisionReview.list({ accountId: owner.accountId, limit: 10 });
    return {
      account:
        account === null
          ? null
          : {
              id: account.id,
              name: account.name,
              cashBalance: account.cashBalance,
              initialCapital: account.initialCapital,
            },
      holdings: holdings.map((item) => ({
        id: item.id,
        stockId: item.stockId,
        quantity: item.quantity,
      })),
      advices: advices.map((item) => ({
        id: item.id,
        decision: item.decision,
        confidence: item.confidence,
        premise: item.reasoning.premise,
        validUntil: item.validUntil.toISOString(),
      })),
      outcomes: outcomes.map((item) => ({
        adviceId: item.adviceId,
        outcome: item.outcome,
        pnl: item.pnl ?? null,
      })),
      strategies: strategies.map((item) => ({
        id: item.id,
        name: item.name,
        currentVersionId: item.currentVersionId ?? null,
      })),
      runs: runs.map((item) => ({
        id: item.id,
        strategyId: item.strategyId,
        status: item.status,
        publication: item.publication?.status ?? null,
      })),
      schedule:
        schedule === null
          ? null
          : { cron: schedule.cron, timezone: schedule.timezone, enabled: schedule.enabled },
      subscriptions: subscriptions.map((item) => ({
        strategyId: item.strategyId,
        watchlistId: item.watchlistId,
        status: item.status,
      })),
      reviews: reviews.map((item) => ({
        id: item.review.id,
        subject: item.review.subject,
        revision: item.revision.revision,
        changeNote: item.revision.changeNote,
      })),
    };
  } finally {
    close();
  }
};

if (import.meta.main) {
  const [mode, home, ownerJson] = process.argv.slice(2);
  if (mode === undefined || home === undefined || ownerJson === undefined)
    throw new Error('Usage: panels-fixture.ts <seed|dump> <home> <ownerJson>');
  const owner = JSON.parse(ownerJson) as PanelsFixtureOwner;
  const result =
    mode === 'seed'
      ? await seedPanelsFixture(home, owner)
      : mode === 'dump'
        ? await dumpPanelsFixture(home, owner)
        : undefined;
  if (result === undefined) throw new Error(`Unknown mode: ${mode}`);
  process.stdout.write(JSON.stringify(result));
}
