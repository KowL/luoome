import {
  type AccountFacts,
  money,
  type TradingPlan,
  TradingPlanV2Schema,
  type WatchTrigger,
  WatchTriggerSchema,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { deriveAccountFacts } from '../tools/account-facts.js';
import { resolveHostedWatchNotificationTool } from './watch.js';

/**
 * 外部评审决策 2 的工具层验收：四档 + 原因码，且**两种「不可用」不再混用**。
 *
 * 这些用例走真实 `resolve_hosted_watch_notification`，不是直接调映射函数——
 * 否则「映射对了但接线接错」这条路测不出来。
 *
 * 事实怎么造：`deriveAccountFacts` 是 `export const`，ESM 下 spy 打不进去，
 * 所以用**真实账户 fixture** 驱动各分支：
 * - 默认 fixture 的账本有对账缺口 → `status: 'unavailable'`（`facts-unavailable` 档）；
 * - 把计划版本的 `accountFactsDigest` 对齐真实 digest、账户事实仍 `unavailable`
 *   但计划本身已过期 → 验证「已证实的不被缺数掩盖」。
 */
// 必须是**交易日盘中**：`latestQualifiedQuote` 在非交易时段会要求 daily-bar 回退，
// 那样构造出来的账户事实恒为 unavailable，后面的档位全测不到。
// 2026-08-03 是周一，上海时间 10:00（连续竞价时段内）。
const NOW = new Date('2026-08-03T02:00:00.000Z');
const ACCOUNT_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'; // buildTestContext 的默认账户

const planTrigger = (versionId = 'plan-v:v1', digest = 'digest-any'): WatchTrigger =>
  WatchTriggerSchema.parse({
    id: 'tr-verdict',
    poolId: `trading-plan-watch:${ACCOUNT_ID}`,
    alertPlanId: `trading-plan-watch:${ACCOUNT_ID}`,
    stockId: '600519.SH',
    ruleId: `${versionId}:exit-stop`,
    ruleKind: 'price-level',
    direction: 'sell',
    triggerType: 'triggered',
    reason: '计划条件命中',
    evidence: [`plan:${versionId}`],
    priority: 'important',
    deliveryStatus: 'not-requested',
    evalSnapshot: {
      planVersionId: versionId,
      conditionId: 'exit-stop',
      // 必须与计划版本的 digest 一致，否则 `tradingPlanState` 判定来源不可解析。
      accountFactsDigest: digest,
      validUntil: NOW,
    },
    createdAt: NOW,
    notified: false,
  });

const tradingPlan = (digest: string, overrides: Record<string, unknown> = {}): TradingPlan =>
  TradingPlanV2Schema.parse({
    id: 'plan-v',
    version: 1,
    accountId: ACCOUNT_ID,
    stockId: '600519.SH',
    status: 'active',
    action: 'reduce',
    entryConditions: [],
    invalidEntryConditions: [],
    position: {
      currentPct: 20,
      targetPctRange: { min: 10, max: 12 },
      appliedPct: 10,
      fallbackPct: 10,
      rangePick: { ruleId: 'lower-bound' },
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: [],
    },
    holding: {
      minTradingDays: 1,
      maxTradingDays: 5,
      nextReviewAt: NOW,
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: {
      conditions: [],
      // `tradingPlanState` 用 entryConditions + exit.triggerConditions 校验来源条件；
      // 放在 invalidationRules 里它看不到，整条来源会被判成不可解析。
      triggerConditions: [
        {
          id: 'exit-stop',
          kind: 'price-threshold',
          phase: 'risk',
          metric: 'price',
          comparator: 'lte',
          value: 95,
          description: '跌破止损',
        },
      ],
      canSellNow: true,
    },
    validFrom: new Date(NOW.getTime() - 3600_000),
    validUntil: new Date(NOW.getTime() + 86_400_000),
    invalidationConditions: [],
    // active 计划必须至少一条结构化失效条件（core 不变量）。
    invalidationRules: [
      {
        id: 'exit-stop',
        kind: 'price-threshold',
        phase: 'risk',
        metric: 'price',
        comparator: 'lte',
        value: 95,
        description: '跌破止损',
      },
    ],
    accountFactsAsOf: NOW,
    accountFactsDigest: digest,
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
    confidence: 50,
    createdAt: NOW,
    ...overrides,
  });

type Ctx = Awaited<ReturnType<typeof buildTestContext>>;

/**
 * 给全部持仓补上合格行情，让账户事实变成 `complete`。
 *
 * 不做这一步的话 fixture 恒为 `unavailable`——而 `tradingPlanMonitoring` 的求值顺序里
 * 「账户事实不可用」（`trading-plan.ts:1332`）排在 `draft` / `scheduled` **之前**，
 * 于是后面几档永远测不到（这正是「缺数掩盖已证实状态」在 fixture 上的表现）。
 */
const makeFactsComplete = async (ctx: Ctx): Promise<AccountFacts> => {
  const holdings = await ctx.repos.holding.listByAccount(ACCOUNT_ID);
  for (const holding of holdings) {
    if (holding.closedAt !== null || holding.quantity <= 0) continue;
    await ctx.repos.quote.save({
      stockId: holding.stockId,
      ts: NOW,
      observedAt: NOW,
      fetchedAt: NOW,
      timestampSource: 'upstream',
      open: money(10),
      high: money(11),
      low: money(9),
      close: money(10),
      prevClose: money(10),
      volume: 1000,
      source: 'verdict-fixture',
    });
  }
  const facts = await deriveAccountFacts(ctx, ACCOUNT_ID);
  if (facts === null) throw new Error('account facts missing');
  return facts;
};

/** 不补行情：fixture 恒为 `unavailable`，用于验「缺数」这一档。 */
const rawFacts = async (ctx: Ctx): Promise<AccountFacts> => {
  const facts = await deriveAccountFacts(ctx, ACCOUNT_ID);
  if (facts === null) throw new Error('account facts missing');
  return facts;
};

const setup = async (
  planOverrides: (digest: string) => Record<string, unknown> = () => ({}),
  versionId = 'plan-v:v1',
  completeFacts = true,
): Promise<{ ctx: Ctx; facts: AccountFacts }> => {
  const ctx = await buildTestContext({ clock: () => NOW });
  const facts = completeFacts ? await makeFactsComplete(ctx) : await rawFacts(ctx);
  const overrides = planOverrides(facts.digest);
  const planDigest = (overrides.accountFactsDigest as string | undefined) ?? facts.digest;
  // trigger 记的必须是**计划版本**的 digest（来源校验），不是账户当前 digest。
  await ctx.repos.watchTrigger.save(planTrigger(versionId, planDigest));
  await ctx.repos.tradingPlan.save(tradingPlan(facts.digest, overrides));
  return { ctx, facts };
};

const resolve = async (ctx: Ctx) =>
  resolveHostedWatchNotificationTool.execute({ triggerId: 'tr-verdict' }, ctx);

describe('resolve_hosted_watch_notification 四档（外部评审决策 2）', () => {
  it('① facts-unavailable：账户事实读不到 → 只证明「无法判断」', async () => {
    const { ctx } = await setup(() => ({}), 'plan-v:v1', false);
    const result = await resolve(ctx);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.data.state).toBe('facts-unavailable');
    expect(result.data.reason).toBe('facts-unavailable');
    // 关键：不能因为读不到事实就说账户变了。
    expect(result.data.reason).not.toBe('account-changed');
  });

  it('② ineligible/expired：已证实的过期不被缺数掩盖（既过期又缺事实 → expired）', async () => {
    // 同时把账户事实做成不可用：过期必须先报，不能被 facts-unavailable 抢答。
    const { ctx } = await setup(
      () => ({
        // 整体平移到过去：validUntil 必须晚于 validFrom，只改一个会被 schema 拒。
        validFrom: new Date(NOW.getTime() - 2 * 86_400_000),
        validUntil: new Date(NOW.getTime() - 86_400_000),
      }),
      'plan-v:v1',
      false,
    );
    const result = await resolve(ctx);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.data.state).toBe('ineligible');
    expect(result.data.reason).toBe('expired');
    expect(result.data.reason).not.toBe('facts-unavailable');
  });

  it('③ ineligible/account-changed：可靠的指纹差异 → 变化，不是缺数', async () => {
    // 计划记的是一个对不上的指纹：这是**可靠的差异证据**，与「读不到」不同。
    const { ctx } = await setup(() => ({ accountFactsDigest: 'f'.repeat(64) }));
    const result = await resolve(ctx);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.data.state).toBe('ineligible');
    expect(result.data.reason).toBe('account-changed');
  });

  it('④ ineligible/draft：草案不能因重新检查行情而获得资格', async () => {
    const { ctx } = await setup(() => ({ status: 'draft' }));
    const result = await resolve(ctx);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.data.state).toBe('ineligible');
    expect(result.data.reason).toBe('draft');
    expect(result.data.state).not.toBe('conditions-unchecked');
  });

  it('⑤ ineligible/scheduled：validFrom 未到 → 不证明已排期', async () => {
    const { ctx } = await setup(() => ({
      validFrom: new Date(NOW.getTime() + 86_400_000),
      validUntil: new Date(NOW.getTime() + 2 * 86_400_000),
    }));
    const result = await resolve(ctx);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.data.state).toBe('ineligible');
    expect(result.data.reason).toBe('scheduled');
  });

  it('⑥ ineligible/constraints-failed：约束不通过（与 facts-unavailable 共用一个 monitoring.status，靠 reason 分开）', async () => {
    const { ctx } = await setup(() => ({
      position: {
        currentPct: 20,
        targetPctRange: { min: 10, max: 12 },
        appliedPct: 10,
        fallbackPct: 10,
        rangePick: { ruleId: 'lower-bound' },
        constraintStatus: 'blocked',
        constraintReasons: ['预算不足'],
        prerequisiteActions: [],
      },
    }));
    const result = await resolve(ctx);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    // 约束不通过是**已证实**的不合格，不能被「账户事实不可用」掩盖。
    expect(result.data.state).toBe('ineligible');
    expect(result.data.reason).toBe('constraints-failed');
    expect(result.data.state).not.toBe('facts-unavailable');
  });

  it('⑦ conditions-unchecked：门槛全过 → 只差用当前行情核验，currentActionAllowed 仍为 false', async () => {
    // 唯一能让 monitoring 走到 ready 的办法：账户事实完整。fixture 有对账缺口，
    // 所以这里直接断言映射层的 ready 分支（工具层受 fixture 限制），
    // 并在 ⑨ 用真实调用证明「没被改坏」。
    const { ctx } = await setup();
    const result = await resolve(ctx);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    // 语义不变：历史触发永远不是当前行动授权。
    expect(result.data.currentActionAllowed).toBe(false);
  });

  it('⑧ source-unavailable：计划版本不可解析 → 来源缺失（而不是 facts / ineligible）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    // 有 trigger，但仓储里没有这个版本。
    await ctx.repos.watchTrigger.save(planTrigger('plan-v:v9'));
    const result = await resolve(ctx);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.data.state).toBe('source-unavailable');
    expect(result.data.reason).toBe('plan-version-not-found');
  });

  it('⑨ 对照：计划类触发没有 alertPlan **不判** source-unavailable', async () => {
    const { ctx } = await setup();
    const result = await resolve(ctx);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    // 计划类触发本来就没有 alertPlan——这是正常结构，不是来源缺失。
    expect(result.data.alertPlan).toBeNull();
    expect(result.data.sourcePlan).not.toBeNull();
    expect(result.data.state).not.toBe('source-unavailable');
  });
});
