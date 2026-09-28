import { TradingPlanSchema, WatchTriggerSchema } from '@luoome/core';
import { addHoldingTool, getAccountFactsTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { intradayTradingPlanWatchWorkflow } from './intraday-trading-plan-watch.js';

const NOW = new Date('2026-07-17T06:00:00.000Z');
/** fixtures 里的长期账户：无持仓、现金 50 万，适合作为「当前持仓」口径的测试账户。 */
const ACCOUNT_ID = 'a1b2c3d4-0001-4000-8000-000000000001';

const buildPlanWatchContext = (opts: Parameters<typeof buildTestContext>[0]) =>
  buildTestContext({ ...opts, marketTimestampSource: 'upstream' });

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
  it('其它持仓只有抓取时间时，不用该估值形成新股票的行动候选', async () => {
    const ctx = await buildPlanWatchContext({ clock: () => NOW });
    const facts = await seedFacts(ctx, [{ stockId: '002594.SZ', quantity: 100, avgCost: 50 }]);
    await ctx.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest, '600519.SH'));
    const batchQuote = ctx.adapters.market.batchQuote.bind(ctx.adapters.market);
    ctx.adapters.market.batchQuote = async (stockIds) => {
      const quotes = await batchQuote(stockIds);
      const held = quotes.get('002594.SZ');
      if (held !== undefined) {
        quotes.set('002594.SZ', {
          ...held,
          source: 'fuyao',
          timestampSource: 'retrieval',
          observedAt: held.fetchedAt,
          ts: held.fetchedAt,
        });
      }
      return quotes;
    };

    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: false },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('blocked');
    expect(result.data.freshQuotes).toBe(1);
    expect(result.data.triggers).toEqual([]);
    expect(result.data.notified).toBe(0);
    expect(result.data.errors.join('；')).toContain('002594.SZ');
    expect(await ctx.repos.trade.listByAccount(ACCOUNT_ID)).toEqual([]);
  });

  it.each([
    ['午休', new Date('2026-07-17T03:30:00.000Z')],
    ['闭市', new Date('2026-07-17T07:00:00.000Z')],
    ['休市日', new Date('2026-09-25T02:00:00.000Z')],
  ])('%s 不执行盘中监控', async (_label, at) => {
    const ctx = await buildPlanWatchContext({ clock: () => at });
    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('blocked');
    expect(result.data.checkedPlans).toBe(0);
    expect(result.data.triggers).toEqual([]);
    expect(result.data.errors).toContain('非交易时段，盘中计划监控未执行');
  });

  it('候选形成后跨过收盘时保存失效审计，不提交规则边沿或发送提醒', async () => {
    let now = new Date('2026-07-17T06:59:30.000Z');
    const ctx = await buildPlanWatchContext({ clock: () => now });
    const facts = await seedFacts(ctx);
    await ctx.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));
    const originalCount = ctx.repos.watchTrigger.countAttemptedSince.bind(ctx.repos.watchTrigger);
    ctx.repos.watchTrigger.countAttemptedSince = async (...args) => {
      now = new Date('2026-07-17T07:00:00.000Z');
      return originalCount(...args);
    };
    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('partial');
    expect(result.data.triggers).toMatchObject([{ deliveryStatus: 'invalidated' }]);
    expect(result.data.notified).toBe(0);
    expect(await ctx.repos.watchRuleState.listByPool(`trading-plan-watch:${ACCOUNT_ID}`)).toEqual(
      [],
    );
  });

  it('投递开始后跨过收盘时作废待发送提醒', async () => {
    let now = new Date('2026-07-17T06:59:30.000Z');
    const ctx = await buildPlanWatchContext({ clock: () => now });
    const facts = await seedFacts(ctx);
    await ctx.repos.tradingPlan.save(
      TradingPlanSchema.parse({
        ...makePlan(ACCOUNT_ID, facts.digest),
        validUntil: new Date('2026-07-21T00:00:00.000Z'),
      }),
    );
    const originalBegin = ctx.repos.watchTrigger.beginDelivery.bind(ctx.repos.watchTrigger);
    let crossed = false;
    ctx.repos.watchTrigger.beginDelivery = async (...args) => {
      await originalBegin(...args);
      if (!crossed) {
        crossed = true;
        now = new Date('2026-07-17T07:00:00.000Z');
      }
    };
    const notification = ctx.notification;
    if (notification === undefined) throw new Error('test notification manager missing');
    const send = vi.spyOn(notification, 'send');
    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('partial');
    expect(result.data.triggers).toMatchObject([{ deliveryStatus: 'invalidated' }]);
    expect(result.data.notified).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(
      await ctx.repos.watchTrigger.listRecent({ poolId: `trading-plan-watch:${ACCOUNT_ID}` }),
    ).toMatchObject([
      {
        deliveryStatus: 'invalidated',
        deliveryAttempts: 1,
        evalSnapshot: { publicationReason: '非交易时段，未发送剩余盘中行动信号' },
      },
    ]);
    const states = await ctx.repos.watchRuleState.listByPool(`trading-plan-watch:${ACCOUNT_ID}`);
    expect(states).toMatchObject([{ active: false }]);
    expect(states[0]?.firstTriggeredAt).toBeUndefined();

    now = new Date('2026-07-20T01:30:01.000Z');
    const nextSession = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(nextSession.ok).toBe(true);
    if (!nextSession.ok) return;
    expect(nextSession.data.triggers).toMatchObject([{ deliveryStatus: 'sent' }]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['pending', 'failed'] as const)(
    '上个交易时段 %s 的投递在下个交易时段重新求值',
    async (interruptedStatus) => {
      let now = NOW;
      const base = await buildPlanWatchContext({ clock: () => now });
      const facts = await seedFacts(base);
      await base.repos.tradingPlan.save(
        TradingPlanSchema.parse({
          ...makePlan(ACCOUNT_ID, facts.digest),
          validUntil: new Date('2026-07-21T00:00:00.000Z'),
        }),
      );
      const originalBegin = base.repos.watchTrigger.beginDelivery.bind(base.repos.watchTrigger);
      let interruptBegin = interruptedStatus === 'pending';
      base.repos.watchTrigger.beginDelivery = async (...args) => {
        if (interruptBegin) {
          interruptBegin = false;
          throw new Error('synthetic interrupted delivery');
        }
        return originalBegin(...args);
      };
      const notification = base.notification;
      if (notification === undefined) throw new Error('test notification manager missing');
      let interruptSend = interruptedStatus === 'failed';
      const ctx = {
        ...base,
        notification: {
          send: async (input: Parameters<typeof notification.send>[0]) => {
            if (interruptSend) {
              interruptSend = false;
              throw new Error('synthetic channel outage');
            }
            return notification.send(input);
          },
        },
      };
      const first = await intradayTradingPlanWatchWorkflow.run(
        { accountId: ACCOUNT_ID, notify: true },
        ctx,
      );
      expect(first.ok).toBe(true);
      expect(
        (
          await base.repos.watchTrigger.listRecent({ poolId: `trading-plan-watch:${ACCOUNT_ID}` })
        )[0]?.deliveryStatus,
      ).toBe(interruptedStatus);

      now = new Date('2026-07-20T01:30:01.000Z');
      const resumed = await intradayTradingPlanWatchWorkflow.run(
        { accountId: ACCOUNT_ID, notify: true },
        ctx,
      );
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.data.triggers).toMatchObject([{ deliveryStatus: 'sent' }]);
      const records = await base.repos.watchTrigger.listRecent({
        poolId: `trading-plan-watch:${ACCOUNT_ID}`,
      });
      expect(records).toMatchObject([
        { deliveryStatus: 'sent' },
        {
          deliveryStatus: interruptedStatus === 'pending' ? 'invalidated' : 'failed',
        },
      ]);
    },
  );

  it('午休前失败的提醒在下午以新行情重评一次，不再重试上午旧事件', async () => {
    let now = new Date('2026-07-17T03:29:30.000Z');
    const base = await buildPlanWatchContext({ clock: () => now });
    const facts = await seedFacts(base);
    await base.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));
    const notification = base.notification;
    if (notification === undefined) throw new Error('test notification manager missing');
    let sends = 0;
    const ctx = {
      ...base,
      notification: {
        send: async (input: Parameters<typeof notification.send>[0]) => {
          sends += 1;
          if (sends === 1) throw new Error('synthetic channel outage');
          return notification.send(input);
        },
      },
    };
    const morning = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(morning.ok).toBe(true);
    now = new Date('2026-07-17T05:00:01.000Z');
    const afternoon = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(afternoon.ok).toBe(true);
    if (!afternoon.ok) return;
    expect(afternoon.data.triggers).toMatchObject([{ deliveryStatus: 'sent' }]);
    expect(sends).toBe(2);
    expect(
      await base.repos.watchTrigger.listRecent({ poolId: `trading-plan-watch:${ACCOUNT_ID}` }),
    ).toMatchObject([{ deliveryStatus: 'sent' }, { deliveryStatus: 'failed' }]);
  });

  it('仅有抓取时间的报价不能触发盘中行动', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const facts = await seedFacts(ctx);
    await ctx.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));

    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.freshQuotes).toBe(0);
    expect(result.data.triggers).toEqual([]);
    expect(result.data.errors.join('；')).toContain('可核验上游时间');
  });

  it('开盘时不把 120 秒内的盘前报价当作盘中行动事实', async () => {
    const quoteTime = new Date('2026-07-17T01:29:30.000Z');
    const now = new Date('2026-07-17T01:30:00.000Z');
    const base = await buildPlanWatchContext({ clock: () => quoteTime });
    const ctx = { ...base, clock: () => now };
    const facts = await seedFacts(ctx);
    await ctx.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));

    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.freshQuotes).toBe(0);
    expect(result.data.triggers).toEqual([]);
  });

  it('上游报价超过 120 秒时不能触发盘中行动', async () => {
    const quoteTime = new Date(NOW.getTime() - 121_000);
    const base = await buildPlanWatchContext({ clock: () => quoteTime });
    const ctx = { ...base, clock: () => NOW };
    const facts = await seedFacts(ctx);
    await ctx.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));

    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.freshQuotes).toBe(0);
    expect(result.data.triggers).toEqual([]);
    expect(result.data.errors.join('；')).toContain('不超过 120 秒');
  });

  it('上游报价的抓取时间晚于当前时钟时不能触发盘中行动', async () => {
    const base = await buildPlanWatchContext({ clock: () => NOW });
    const facts = await seedFacts(base);
    await base.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));
    const fetchQuote = base.adapters.market.fetchQuote.bind(base.adapters.market);
    const market = Object.assign(Object.create(base.adapters.market), {
      fetchQuote: async (stockCode: string) => ({
        ...(await fetchQuote(stockCode)),
        fetchedAt: new Date(NOW.getTime() + 60_000),
      }),
    });
    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      { ...base, adapters: { ...base.adapters, market } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.freshQuotes).toBe(0);
    expect(result.data.triggers).toEqual([]);
  });

  it('试跑不消耗正式边沿，正式触发后不重复发送', async () => {
    const ctx = await buildPlanWatchContext({ clock: () => NOW });
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

    expect(await ctx.repos.watchRuleState.listByPool(`trading-plan-watch:${ACCOUNT_ID}`)).toEqual(
      [],
    );
    expect(
      await ctx.repos.watchTrigger.listRecent({ poolId: `trading-plan-watch:${ACCOUNT_ID}` }),
    ).toEqual([]);
    const formal = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(formal.ok && formal.data.triggers.length).toBe(1);
    if (formal.ok) {
      const trigger = formal.data.triggers[0];
      expect(trigger?.evalSnapshot).toMatchObject({
        firstEventAt: new Date(NOW.getTime() - 1_000).toISOString(),
        firstAcquiredAt: NOW.toISOString(),
        publicationCheckedAt: NOW.toISOString(),
      });
      expect(trigger?.deliveryCompletedAt).toEqual(NOW);
      expect(await ctx.repos.watchTrigger.findById(trigger?.id ?? '')).toMatchObject({
        lastDeliveryAttemptAt: NOW,
        deliveryCompletedAt: NOW,
      });
    }
    const second = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.triggers).toEqual([]);
  });

  it('入场按全部条件求值，部分满足不提醒；全部满足只发一条且保留全部证据', async () => {
    const ctx = await buildPlanWatchContext({ clock: () => NOW });
    const facts = await seedFacts(ctx);
    const plan = makePlan(ACCOUNT_ID, facts.digest);
    const second = {
      ...plan.entryConditions[0],
      kind: 'price-threshold' as const,
      phase: 'entry' as const,
      metric: 'price' as const,
      comparator: 'gte' as const,
      id: 'entry-second',
      value: 100000,
      description: '第二个条件',
    };
    await ctx.repos.tradingPlan.save({
      ...plan,
      entryConditions: [...plan.entryConditions, second],
    });
    const first = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: false },
      ctx,
    );
    expect(first.ok && first.data.triggers).toEqual([]);
    await ctx.repos.tradingPlan.save({
      ...plan,
      version: 2,
      entryConditions: [...plan.entryConditions, { ...second, value: 0 }],
    });
    const next = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: false },
      ctx,
    );
    expect(next.ok && next.data.triggers.length).toBe(1);
    if (next.ok)
      expect(next.data.triggers[0]?.evalSnapshot.conditionIds).toEqual([
        'entry-now',
        'entry-second',
      ]);
  });

  it('风险命中时不发送入场提醒，未持仓风险不伪装成卖出指令', async () => {
    const ctx = await buildPlanWatchContext({ clock: () => NOW });
    const facts = await seedFacts(ctx);
    const plan = makePlan(ACCOUNT_ID, facts.digest);
    await ctx.repos.tradingPlan.save({
      ...plan,
      exit: {
        ...plan.exit,
        triggerConditions: [
          {
            ...plan.entryConditions[0],
            kind: 'price-threshold' as const,
            metric: 'price' as const,
            comparator: 'gte' as const,
            value: 0,
            id: 'stop',
            phase: 'risk',
            description: '入场前已失效',
          },
        ],
      },
    });
    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: false },
      ctx,
    );
    expect(result.ok && result.data.triggers.length).toBe(1);
    if (result.ok) {
      expect(result.data.triggers[0]?.priority).toBe('urgent');
      expect(result.data.triggers[0]?.direction).toBe('watch');
      expect(result.data.triggers[0]?.evalSnapshot.nextStep).toContain('暂停入场');
    }
  });

  it('人工确认与过期市场事实不能由价格命中代替', async () => {
    for (const kind of ['manual-confirmation', 'market-fact'] as const) {
      const ctx = await buildPlanWatchContext({ clock: () => NOW });
      const facts = await seedFacts(ctx);
      const plan = makePlan(ACCOUNT_ID, facts.digest);
      await ctx.repos.tradingPlan.save({
        ...plan,
        entryConditions: [
          ...plan.entryConditions,
          {
            id: 'confirmation',
            kind,
            phase: 'entry',
            factId: 'market',
            description: '等待确认',
          },
        ],
        marketFacts: [
          {
            id: 'market',
            metric: 'price',
            value: 1,
            unit: 'CNY',
            source: 'fixture',
            observedAt: new Date(NOW.getTime() - 11 * 60000),
            fetchedAt: NOW,
            timestampSource: 'upstream',
            frequency: 'quote',
            status: 'available',
          },
        ],
      });
      const result = await intradayTradingPlanWatchWorkflow.run(
        { accountId: ACCOUNT_ID, notify: false },
        ctx,
      );
      expect(result.ok && result.data.triggers).toEqual([]);
      expect(result.ok && result.data.status).toBe('partial');
    }
  });

  it('刷新没有计划的持仓行情，使整账户事实恢复可用', async () => {
    const ctx = await buildPlanWatchContext({ clock: () => NOW });
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
    const ctx = await buildPlanWatchContext({ clock: () => NOW });
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
    const ctx = await buildPlanWatchContext({ clock: () => NOW });
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

  it('风险立即通知，不调用 AI 或改写计划，保留原始事实和下一步', async () => {
    const base = await buildPlanWatchContext({
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
    const generate = vi.fn();
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
          generate: async <T = unknown>(): Promise<T> => {
            generate();
            throw new Error('盘中通知不得等待 AI');
          },
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
    expect(
      (await base.repos.tradingPlan.list({ accountId: ACCOUNT_ID })).map((item) => item.version),
    ).toEqual([1]);
    expect(result.data.triggers[0]?.deliveryStatus).toBe('sent');
    expect(result.data.notified).toBe(1);
    expect(sends).toBe(1);
    expect(content).not.toContain('account:');
    expect(content).not.toContain(':v1');
    expect(result.data.triggers[0]?.evalSnapshot.planVersionId).toBe(`${plan.id}:v1`);
    expect(content).toContain('北京时间');
    expect(content.length).toBeLessThan(800);
    expect(content).toContain('请优先复核持仓');
    expect(content).toContain('反证：');
    expect(generate).not.toHaveBeenCalled();
  });

  it('发布前发现账户事实变化时不提交边沿或发送旧信号', async () => {
    let now = NOW;
    const base = await buildPlanWatchContext({ clock: () => now, advices: [] });
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

  it('候选形成后账户账本变化时保存失效审计，且不消耗边沿', async () => {
    const base = await buildPlanWatchContext({ clock: () => NOW, advices: [] });
    const facts = await seedFacts(base);
    await base.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));
    const originalCount = base.repos.watchTrigger.countAttemptedSince.bind(base.repos.watchTrigger);
    let changed = false;
    base.repos.watchTrigger.countAttemptedSince = async (...args) => {
      if (!changed) {
        changed = true;
        const added = await addHoldingTool.execute(
          { accountId: ACCOUNT_ID, stockId: '600519.SH', quantity: 1, avgCost: 100 },
          base,
        );
        expect(added.ok).toBe(true);
      }
      return originalCount(...args);
    };
    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      base,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(changed).toBe(true);
    expect(result.data.status).toBe('partial');
    expect(result.data.triggers).toEqual([
      expect.objectContaining({ deliveryStatus: 'invalidated' }),
    ]);
    expect(
      await base.repos.watchTrigger.listRecent({ poolId: `trading-plan-watch:${ACCOUNT_ID}` }),
    ).toMatchObject([{ deliveryStatus: 'invalidated' }]);
    expect(await base.repos.watchRuleState.listByPool(`trading-plan-watch:${ACCOUNT_ID}`)).toEqual(
      [],
    );
  });

  it('通知失败后在退避窗口内重试同一触发并恢复送达', async () => {
    let now = NOW;
    const base = await buildPlanWatchContext({ clock: () => now, advices: [] });
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

  it('发布刷新行情后，重试仍从首次上游事件时间计算 10 分钟', async () => {
    let now = NOW;
    const base = await buildPlanWatchContext({ clock: () => now, advices: [] });
    const facts = await seedFacts(base);
    await base.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));
    const notification = base.notification;
    if (notification === undefined) throw new Error('test notification manager missing');
    const fetchQuote = base.adapters.market.fetchQuote.bind(base.adapters.market);
    let quoteFetches = 0;
    const delayedMarket = Object.assign(Object.create(base.adapters.market), {
      fetchQuote: async (stockCode: string) => {
        const quote = await fetchQuote(stockCode);
        quoteFetches += 1;
        if (quoteFetches > 1) return quote;
        const observedAt = new Date(quote.observedAt.getTime() - 90_000);
        return { ...quote, observedAt, ts: observedAt };
      },
    });
    let sends = 0;
    const ctx = {
      ...base,
      adapters: { ...base.adapters, market: delayedMarket },
      notification: {
        send: async (input: Parameters<typeof notification.send>[0]) => {
          sends += 1;
          throw new Error(`synthetic channel outage: ${input.channel}`);
        },
      },
    };
    const first = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(quoteFetches).toBeGreaterThanOrEqual(2);
    expect(first.data.triggers[0]?.evalSnapshot.firstEventAt).toBe(
      new Date(NOW.getTime() - 91_000).toISOString(),
    );
    expect(first.data.triggers[0]?.evalSnapshot.quoteObservedAt).toEqual(
      new Date(NOW.getTime() - 1_000),
    );
    expect(sends).toBe(1);

    now = new Date(NOW.getTime() + 9 * 60_000);
    const retry = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      ctx,
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.errors).toContain('002594.SZ 盘中信号超过 10 分钟发布时限，放弃本轮信号');
    expect(retry.data.triggers).toEqual([expect.objectContaining({ deliveryStatus: 'expired' })]);
    expect(
      (await base.repos.watchTrigger.listRecent({ poolId: `trading-plan-watch:${ACCOUNT_ID}` }))[0],
    ).toMatchObject({
      deliveryStatus: 'expired',
      evalSnapshot: {
        firstEventAt: new Date(NOW.getTime() - 91_000).toISOString(),
        publicationReason: '002594.SZ 盘中信号超过 10 分钟发布时限，放弃本轮信号',
      },
    });
    expect(sends).toBe(1);
  });

  it('发布前行情请求跨过 10 分钟时按请求结束时间阻断信号', async () => {
    let now = NOW;
    const base = await buildPlanWatchContext({ clock: () => now, advices: [] });
    const facts = await seedFacts(base);
    await base.repos.tradingPlan.save(makePlan(ACCOUNT_ID, facts.digest));
    const fetchQuote = base.adapters.market.fetchQuote.bind(base.adapters.market);
    let quoteFetches = 0;
    const market = Object.assign(Object.create(base.adapters.market), {
      fetchQuote: async (stockCode: string) => {
        quoteFetches += 1;
        if (quoteFetches === 2) now = new Date(NOW.getTime() + 11 * 60_000);
        return fetchQuote(stockCode);
      },
    });
    const result = await intradayTradingPlanWatchWorkflow.run(
      { accountId: ACCOUNT_ID, notify: true },
      { ...base, adapters: { ...base.adapters, market }, clock: () => now },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(quoteFetches).toBeGreaterThanOrEqual(2);
    expect(result.data.errors).toContain('002594.SZ 盘中信号超过 10 分钟发布时限，放弃本轮信号');
    expect(result.data.triggers).toEqual([]);
  });

  it('超过时限的未投递重试不阻断其它股票的新信号', async () => {
    let now = NOW;
    const base = await buildPlanWatchContext({ clock: () => now });
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
    const base = await buildPlanWatchContext({ clock: () => NOW });
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

  it('旧触发缺可信上游事件时间时不按检测时间重新计时', async () => {
    const base = await buildPlanWatchContext({ clock: () => NOW });
    const facts = await seedFacts(base);
    const plan = makePlan(ACCOUNT_ID, facts.digest);
    await base.repos.tradingPlan.save(plan);
    await base.repos.watchTrigger.save(
      WatchTriggerSchema.parse({
        id: 'missing-upstream-evidence',
        poolId: `trading-plan-watch:${ACCOUNT_ID}`,
        stockId: plan.stockId,
        ruleKind: 'price-level',
        ruleId: `${plan.id}:v${plan.version}:entry-now`,
        direction: 'buy',
        reason: '缺事件时间的旧重试',
        evidence: ['plan:fixture'],
        priority: 'normal',
        deliveryStatus: 'pending',
        evalSnapshot: {
          planVersionId: `${plan.id}:v${plan.version}`,
          conditionId: 'entry-now',
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
    expect(result.data.errors).toContain(
      '002594.SZ 盘中信号缺可信上游事件时间，无法核验 10 分钟发布时限',
    );
    expect(result.data.triggers).toContainEqual(
      expect.objectContaining({ id: 'missing-upstream-evidence', deliveryStatus: 'unverifiable' }),
    );
    expect(await base.repos.watchTrigger.findById('missing-upstream-evidence')).toMatchObject({
      deliveryStatus: 'unverifiable',
    });
  });
});
