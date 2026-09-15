import { TradingPlanSchema, WatchTriggerSchema } from '@luoome/core';
import { addHoldingTool, getAccountFactsTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { intradayTradingPlanWatchWorkflow } from './intraday-trading-plan-watch.js';

const NOW = new Date('2026-07-17T07:00:00.000Z');
/** fixtures 里的长期账户：无持仓、现金 50 万，适合作为「当前持仓」口径的测试账户。 */
const ACCOUNT_ID = 'a1b2c3d4-0001-4000-8000-000000000001';

const makePlan = (accountId: string, accountFactsDigest: string, stockId = '002594.SZ') =>
  TradingPlanSchema.parse({
    id: `account:${accountId}:stock:${stockId}`,
    version: 1,
    accountId,
    stockId,
    stockName: stockId,
    industry: '汽车',
    status: 'active',
    action: 'enter',
    entryPriceLow: 1,
    entryPriceHigh: 1000,
    entryConditions: [
      {
        id: 'entry-now',
        kind: 'price-threshold',
        phase: 'entry',
        metric: 'price',
        comparator: 'gte',
        value: 0,
        description: '当前行情可观察',
      },
    ],
    invalidEntryConditions: [],
    position: {
      currentPct: 0,
      targetPct: 10,
      deltaPct: 10,
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: ['用户手动执行后更新账户快照'],
    },
    holding: {
      minTradingDays: 3,
      maxTradingDays: 10,
      nextReviewAt: new Date('2026-07-22T00:00:00.000Z'),
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: { conditions: [], triggerConditions: [], canSellNow: false },
    validFrom: new Date('2026-07-16T00:00:00.000Z'),
    validUntil: new Date('2026-07-20T00:00:00.000Z'),
    invalidationConditions: ['账户快照版本改变'],
    accountFactsAsOf: NOW,
    accountFactsDigest: accountFactsDigest,
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
    confidence: 60,
    createdAt: NOW,
  });

/**
 * 按当前持仓建立账户事实：持仓缺合格行情时 facts 会是 unavailable；
 * 计划的 accountFactsDigest 必须与 facts.digest 一致才会被监控。
 */
const seedFacts = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  holdings: readonly { stockId: string; quantity: number; avgCost: number }[] = [],
) => {
  const accountId = ACCOUNT_ID;
  for (const holding of holdings) {
    const added = await addHoldingTool.execute({ accountId, ...holding }, ctx);
    if (!added.ok) throw new Error(`seed holding failed: ${JSON.stringify(added.error)}`);
  }
  const facts = await getAccountFactsTool.execute({ accountId }, ctx);
  if (!facts.ok) throw new Error(`seed facts failed: ${JSON.stringify(facts.error)}`);
  return facts.data.facts;
};

describe('intraday trading plan watch', () => {
  it('uses fresh intraday evidence, persists an edge, and does not repeat it', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const facts = await seedFacts(ctx);
    const plan = makePlan(ACCOUNT_ID, facts.digest);
    await ctx.repos.tradingPlan.save(plan);

    const first = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: false },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.status).toBe('complete');
    expect(first.data.freshQuotes).toBe(1);
    expect(first.data.triggers).toHaveLength(1);
    expect(first.data.triggers[0]?.deliveryStatus).toBe('not-requested');

    const second = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: false },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.triggers).toEqual([]);
  });

  it('刷新没有计划的持仓行情，使整账户事实恢复可用', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const facts = await seedFacts(ctx, [{ stockId: '600519.SH', quantity: 100, avgCost: 10 }]);
    expect(facts.status).toBe('unavailable');
    await ctx.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));
    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: false },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('complete');
    expect(result.data.triggers).toHaveLength(1);
    expect(await ctx.repos.quote.latestByStock('600519.SH')).not.toBeNull();
  });

  it('计划与持仓并集超过 100 只时分批刷新', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const holdings = Array.from({ length: 101 }, (_, i) => ({
      stockId: `${String(1000 + i).padStart(6, '0')}.SZ`,
      quantity: 1,
      avgCost: 1,
    }));
    const facts = await seedFacts(ctx, holdings);
    await ctx.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));
    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: false },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('complete');
    expect(result.data.freshQuotes).toBe(102);
    expect(result.data.triggers).toHaveLength(1);
  });

  it('账户事实不可用（持仓缺合格行情）时暂停精确盘中监控', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const batchQuote = ctx.adapters.market.batchQuote.bind(ctx.adapters.market);
    vi.spyOn(ctx.adapters.market, 'batchQuote').mockImplementation((ids) =>
      batchQuote(ids.filter((id) => id !== '000858.SZ')),
    );
    // 上游缺少该持仓的报价，刷新后仍不可用。
    const facts = await seedFacts(ctx, [{ stockId: '000858.SZ', quantity: 100, avgCost: 10 }]);
    expect(facts.status).toBe('unavailable');
    await ctx.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));

    const result = await intradayTradingPlanWatchWorkflow.run({ accountId: ACCOUNT_ID }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('blocked');
    expect(result.data.errors.join('｜')).toContain('账户事实不可用');
  });

  it('风险触发经 AI 复核后仍发送原始风险事实，并展示最新计划版本', async () => {
    const base = await buildTestContext({
      clock: () => NOW,
      advices: [],
    });
    const facts = await seedFacts(base, [{ stockId: '002594.SZ', quantity: 1000, avgCost: 100 }]);
    const plan = makePlan(ACCOUNT_ID, facts.digest);
    const riskPlan = TradingPlanSchema.parse({
      ...plan,
      action: 'hold',
      entryConditions: [],
      position: { ...plan.position, currentPct: 10, targetPct: 10, deltaPct: 0 },
      exit: {
        ...plan.exit,
        canSellNow: true,
        triggerConditions: [
          {
            id: 'stop-loss',
            kind: 'price-threshold',
            phase: 'risk',
            metric: 'price',
            comparator: 'lte',
            value: 1000,
            description: '价格触及止损',
          },
        ],
      },
    });
    await base.repos.tradingPlan.save(riskPlan);
    let sends = 0;
    let content = '';
    const notification = base.notification;
    if (notification === undefined) throw new Error('test notification manager missing');
    const ctx = {
      ...base,
      adapters: {
        ...base.adapters,
        llm: {
          name: 'review-fixture',
          generate: async <T = unknown>(): Promise<T> =>
            ({
              decision: 'hold' as const,
              confidence: 60,
              horizon: 'short' as const,
              reasoning: {
                premise: '量价仍需观察',
                evidence: ['价格条件已命中'],
                counterEvidence: ['价格低于原止损'],
              },
              risks: ['继续下跌风险'],
            }) as T,
        },
      },
      notification: {
        send: async (input: Parameters<typeof notification.send>[0]) => {
          sends += 1;
          content = input.payload.content;
          return notification.send(input);
        },
      },
    };
    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.reviewedPlans[0]?.status).toBe('saved');
    expect(result.data.triggers[0]?.deliveryStatus).toBe('sent');
    expect(result.data.notified).toBe(1);
    expect(sends).toBe(1);
    expect(content).toContain('计划版本：account:');
    expect(content).toContain(':v2');
    expect(content).toContain('原触发计划版本：');
  });

  it('发布前发现账户事实变化时不提交边沿或发送旧信号', async () => {
    let now = NOW;
    const base = await buildTestContext({ clock: () => now, advices: [] });
    const facts = await seedFacts(base);
    await base.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));
    const originalList = base.repos.watchRuleState.listByPool.bind(base.repos.watchRuleState);
    let injected = false;
    (
      base.repos.watchRuleState as unknown as {
        listByPool: typeof base.repos.watchRuleState.listByPool;
      }
    ).listByPool = async (poolId) => {
      const states = await originalList(poolId);
      if (!injected) {
        injected = true;
        now = new Date(NOW.getTime() + 11 * 60_000);
        const changed = await addHoldingTool.execute(
          {
            accountId: ACCOUNT_ID,
            stockId: '600519.SH',
            quantity: 10,
            avgCost: 1500,
          },
          base,
        );
        expect(changed.ok).toBe(true);
      }
      return states;
    };
    let sends = 0;
    const notification = base.notification;
    if (notification === undefined) throw new Error('test notification manager missing');
    const ctx = {
      ...base,
      notification: {
        send: async (input: Parameters<typeof notification.send>[0]) => {
          sends += 1;
          return notification.send(input);
        },
      },
    };
    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('partial');
    expect(result.data.triggers).toHaveLength(0);
    expect(sends).toBe(0);
    expect(
      await base.repos.watchTrigger.listRecent({
        poolId: `trading-plan-watch:${ACCOUNT_ID}`,
      }),
    ).toHaveLength(0);
  });

  it('通知失败后在退避窗口内重试同一触发并恢复送达', async () => {
    let now = NOW;
    const base = await buildTestContext({ clock: () => now, advices: [] });
    const facts = await seedFacts(base);
    await base.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));
    const notification = base.notification;
    if (notification === undefined) throw new Error('test notification manager missing');
    let calls = 0;
    const ctx = {
      ...base,
      notification: {
        send: async (input: Parameters<typeof notification.send>[0]) => {
          calls += 1;
          if (calls === 1) throw new Error('synthetic channel outage');
          return notification.send(input);
        },
      },
    };
    const first = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(first.ok).toBe(true);
    now = new Date(NOW.getTime() + 2 * 60_000);
    const second = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(calls).toBe(2);
    expect(second.data.delivered).toBe(1);
    const records = await base.repos.watchTrigger.listRecent({
      poolId: `trading-plan-watch:${ACCOUNT_ID}`,
    });
    expect(records[0]?.deliveryStatus).toBe('sent');
    expect(records[0]?.deliveryAttempts).toBe(2);
  });

  it('超过时限的未投递重试不阻断其它股票的新信号', async () => {
    let now = NOW;
    const base = await buildTestContext({ clock: () => now });
    const accountId = ACCOUNT_ID;
    const facts = await seedFacts(base);
    await base.repos.tradingPlan.save(makePlan(accountId, facts.digest));

    const notification = base.notification;
    if (notification === undefined) throw new Error('test notification manager missing');
    let calls = 0;
    const flakyCtx = {
      ...base,
      notification: {
        send: async (input: Parameters<typeof notification.send>[0]) => {
          calls += 1;
          if (calls === 1) throw new Error('synthetic channel outage');
          return notification.send(input);
        },
      },
    };

    // 第一轮：边沿命中但渠道失败，触发以 failed 状态持久化，成为重试候选。
    const first = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      flakyCtx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.triggers[0]?.deliveryStatus).toBe('failed');

    // 第三轮：另一只股票出现全新边沿；同轮里那条已超过 10 分钟的重试只能丢弃自己。
    now = new Date(NOW.getTime() + 12 * 60_000);
    await base.repos.tradingPlan.save(makePlan(accountId, facts.digest, '600519.SH'));
    const third = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      base,
    );
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.data.errors).toEqual(['002594.SZ 盘中信号超过 10 分钟发布时限，放弃本轮信号']);
    expect(third.data.delivered).toBe(1);
    expect(third.data.triggers.find((trigger) => trigger.deliveryStatus === 'sent')?.stockId).toBe(
      '600519.SH',
    );
  });

  it('10 分钟时限以触发证据的上游时间为起点', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    const accountId = ACCOUNT_ID;
    const facts = await seedFacts(base);
    const plan = makePlan(accountId, facts.digest);
    await base.repos.tradingPlan.save(plan);
    const versionId = `${plan.id}:v${plan.version}`;
    // 11 分钟前观测到的上游价格：检测时间才刚发生，但事件本身已经超时。
    await base.repos.watchTrigger.save(
      WatchTriggerSchema.parse({
        id: 'stale-upstream-evidence',
        poolId: `trading-plan-watch:${accountId}`,
        stockId: '002594.SZ',
        ruleKind: 'price-level',
        ruleId: `${versionId}:entry-now`,
        direction: 'buy',
        reason: '过期重试',
        evidence: ['plan:fixture'],
        priority: 'normal',
        deliveryStatus: 'pending',
        evalSnapshot: {
          planVersionId: versionId,
          conditionId: 'entry-now',
          quoteObservedAt: new Date(NOW.getTime() - 11 * 60_000).toISOString(),
        },
        notified: false,
        createdAt: NOW,
      }),
    );

    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      base,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.errors).toEqual(['002594.SZ 盘中信号超过 10 分钟发布时限，放弃本轮信号']);
    // 同轮新检测到的边沿仍然投递。
    expect(result.data.delivered).toBe(1);
  });
});
