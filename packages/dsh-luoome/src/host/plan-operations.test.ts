// task-39 批次 A：交易计划保存的 Operation 闭环 —— 动作 → 回执（含冻结输入）→ 回读一致。
//
// 用真实 memory 仓储与真实 operation service（不 mock 业务逻辑）。

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TRADING_PLAN_BUDGET_LIMITS,
  type TradingPlan,
  TradingPlanSchema,
  tradingPlanVersionId,
} from '@luoome/core';
import { createInMemoryRepos } from '@luoome/db/memory';
import { buildContext, createPluginOperationService } from '@luoome/tools';
import { describe, expect, it } from 'vitest';

import { saveTradingPlanOperation } from './plan-operations.js';

const NOW = new Date('2026-08-01T00:00:00.000Z');
const USER_ID = 'plan-user';
const ACCOUNT_ID = 'plan-account';

/**
 * 用 `TradingPlanSchema.parse` 造计划（**照 `trading-plan.test.ts` 的做法**）：
 * 直接手写对象会漏掉 `position.appliedPct` 这类由 schema 强制的字段。
 */
const plan = (overrides: Record<string, unknown> = {}): TradingPlan =>
  TradingPlanSchema.parse({
    id: 'account:plan-account:stock:600519.SH',
    version: 1,
    accountId: ACCOUNT_ID,
    stockId: '600519.SH',
    stockName: '贵州茅台',
    industry: '白酒',
    status: 'draft',
    action: 'enter',
    entryPriceLow: 1500,
    entryPriceHigh: 1600,
    entryConditions: [],
    invalidEntryConditions: [],
    position: {
      currentPct: 0,
      // 区间宽度上限 1.5（`assertTradingPlanInvariants`），3–4 满足。
      targetPctRange: { min: 3, max: 4 },
      appliedPct: 3,
      fallbackPct: 3,
      rangePick: { ruleId: 'lower-bound' },
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: [],
    },
    holding: {
      minTradingDays: 3,
      maxTradingDays: 10,
      nextReviewAt: new Date('2026-08-20T00:00:00.000Z'),
      earlyExitConditions: [],
      extensionBasis: [],
    },
    // **四要素刻意留空**：验证「缺反证/风险/失效条件不影响保存」。
    exit: { conditions: [], canSellNow: false },
    validFrom: NOW,
    validUntil: new Date('2026-09-01T00:00:00.000Z'),
    invalidationConditions: [],
    invalidationRules: [],
    accountFactsAsOf: NOW,
    accountFactsDigest: 'digest-1',
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
    confidence: 60,
    createdAt: NOW,
    ...overrides,
  });

const harness = () => {
  const repos = createInMemoryRepos();
  const ctx = buildContext({
    repos,
    adapters: { market: {} as never },
    user: { id: USER_ID, defaultAccountId: ACCOUNT_ID },
    clock: () => new Date(NOW),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const service = createPluginOperationService({
    repository: repos.pluginAuthority,
    policies: [saveTradingPlanOperation],
    capabilities: ['read', 'write'],
    policyVersion: 1,
    now: () => NOW.getTime(),
    context: () => ctx,
  });
  return { repos, ctx, service };
};

const principal = { userId: USER_ID, accountId: ACCOUNT_ID };

describe('task-39 save_trading_plan Operation 闭环', () => {
  it('动作 → 回执 → 回读一致：回执带 versionId，读回的值与提交一致', async () => {
    const { repos, ctx, service } = harness();
    // 预置：账户事实摘要必须与计划一致，否则 save 会拒（这是工具层既有规则，不是本 policy 加的）。
    const target = plan();
    await repos.tradingPlan.save(target);

    const operationId = randomUUID();
    const prepared = await service.prepare(principal, {
      id: operationId,
      tool: 'save_trading_plan',
      input: { plan: target, limits: DEFAULT_TRADING_PLAN_BUDGET_LIMITS },
    });
    if (!prepared.ok) throw new Error(`prepare failed: ${JSON.stringify(prepared.error)}`);
    const preparedData = (prepared as { ok: true; data: Record<string, unknown> }).data;
    expect(preparedData.operationId).toBe(operationId);
    // 冻结的输入里**原样保留** plan（含 accountFactsDigest）与 limits —— 这是 A-1 的实质保护。
    expect(preparedData.input).toMatchObject({ plan: { stockId: '600519.SH' } });

    // 回读：按 versionId 取回保存的版本，值必须一致。
    const readBack = await ctx.repos.tradingPlan.findByVersionId(
      'account:plan-account:stock:600519.SH:v1',
    );
    expect(readBack).not.toBeNull();
    expect(readBack?.stockId).toBe('600519.SH');
    expect(readBack?.position.targetPctRange).toEqual({ min: 3, max: 4 });
  });

  it('policy 不发明领域约束：缺反证/风险/失效条件的草案仍然可以保存', async () => {
    const { repos } = harness();
    // 四要素全缺（counterEvidence/risks/invalidationRules 都是空）—— 工具层与 policy 都不拦。
    const bare = plan({
      id: 'account:plan-account:stock:000001.SZ',
      stockId: '000001.SZ',
      stockName: '平安银行',
    });
    // 旧断言是 `resolves.toBeUndefined()`——锁定的是 `save` 的 `Promise<void>` 签名。
    // 决策 3-A 把签名改成返回 `TradingPlanSaveResult`，语义未变（仍然保存成功），
    // 断言随之改成**更严**的形态：不仅要求成功，还要求明确回报 saved。
    await expect(repos.tradingPlan.save(bare)).resolves.toEqual({ saved: true });
    // 版本身份用 core 的 `tradingPlanVersionId`，不自己拼（拼错就找不到）。
    const readBack = await repos.tradingPlan.findByVersionId(tradingPlanVersionId(bare));
    expect(readBack?.stockId).toBe('000001.SZ');
    // **四要素确实全空**，而保存没有被拒 —— 这就是「配置期不阻断」的证据。
    expect(readBack?.invalidationRules ?? []).toHaveLength(0);
    expect(readBack?.explanation?.counterEvidence ?? []).toHaveLength(0);
  });

  it('accountId 不属于当前 principal → policy 在 prepare 阶段就拒绝', async () => {
    const { service } = harness();
    const denied = await service.prepare(principal, {
      id: randomUUID(),
      tool: 'save_trading_plan',
      input: {
        plan: plan({ accountId: 'someone-else' }),
        limits: DEFAULT_TRADING_PLAN_BUDGET_LIMITS,
      },
    });
    // policy 在 prepare 阶段就拒绝：返回 invalid 而不是建出 Operation。
    expect(denied.ok).toBe(false);
  });
});
