import type { StrategyDslV1, ToolContext } from '@luoome/core';
import { strategyDefinitionHash } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { withFixedQuoteAdapter } from '@luoome/tools/testing/fixed-quote-adapter';
import { describe, expect, it } from 'vitest';

import { intradayWatchWorkflow } from './intraday-watch.js';

/**
 * strategy-signal 规则路径单测。
 *
 * 信号窗口语义：只读当日 Asia/Shanghai 00:00 起的持久化 StrategySignal，
 * 历史信号不参与命中（避免历史信号命中后永远 active）。
 */

const T0 = new Date('2026-07-28T01:00:00.000Z'); // 当日 09:00 Asia/Shanghai
const NOW = new Date('2026-07-28T02:00:00.000Z'); // 当日 10:00 Asia/Shanghai
const YESTERDAY = new Date('2026-07-27T01:00:00.000Z'); // 前一上海日 09:00
const STOCK = '002594.SZ';

const DEFINITION: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: {},
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      { id: 'positive-price', name: '价格有效', when: 'quote.close > 0', evidence: ['价格有效'] },
    ],
  },
  scoring: {
    method: 'weighted-sum',
    components: [{ ruleId: 'positive-price', score: '50', weight: 1 }],
  },
  signals: {
    entry: [
      {
        id: 'entry',
        name: '研究信号',
        when: 'quote.close > 0',
        score: '60',
        direction: 'bullish',
        evidence: ['仅供研究'],
      },
    ],
    exit: [],
    risk: [],
  },
};

const seedSignalSetup = async (ctx: ToolContext, signalTs: Date): Promise<void> => {
  // StrategyRun 落库要求绑定 active Strategy 的 published valid version
  await ctx.repos.strategy.save({
    id: 'sig-strategy',
    name: '信号策略',
    description: '测试策略',
    owner: 'user',
    status: 'active',
    currentVersionId: 'sig-strategy-v1',
    createdAt: T0,
    updatedAt: T0,
  });
  await ctx.repos.strategy.saveVersion({
    id: 'sig-strategy-v1',
    strategyId: 'sig-strategy',
    version: 1,
    definition: DEFINITION,
    definitionHash: strategyDefinitionHash(DEFINITION),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: T0,
    createdAt: T0,
  });
  await ctx.repos.strategyRun.saveRun({
    id: 'run-1',
    strategyId: 'sig-strategy',
    strategyVersionId: 'sig-strategy-v1',
    mode: 'scan',
    coverage: 'CN_A_SHARES_SH_SZ',
    dataAsOf: signalTs,
    startedAt: signalTs,
    finishedAt: signalTs,
    status: 'complete',
    inputSnapshot: { candidateStockIds: [STOCK], subset: true, persist: true },
    providerStatuses: [],
    summary: {
      candidates: 1,
      evaluated: 1,
      selected: 0,
      signals: 1,
      partial: 0,
      failed: 0,
      failures: [],
    },
  });
  await ctx.repos.strategyRun.saveSignals([
    {
      id: `signal-${STOCK}`,
      strategyId: 'sig-strategy',
      strategyVersionId: 'sig-strategy-v1',
      runId: 'run-1',
      ruleId: 'entry',
      stockId: STOCK,
      ts: signalTs,
      score: 80,
      direction: 'bullish',
      evidence: ['放量突破'],
      evaluationSnapshot: {},
    },
  ]);
  await ctx.repos.watchlist.save({
    id: 'sig-watch',
    name: '信号观察',
    kind: 'personal',
    membershipPolicy: 'manual',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  });
  await ctx.repos.watchlistMember.saveMember({
    id: `sig-watch:${STOCK}`,
    watchlistId: 'sig-watch',
    stockId: STOCK,
    stage: 'watching',
    priority: 'normal',
    firstAddedAt: T0,
    lastActivityAt: T0,
  });
  await ctx.repos.alertPlan.save({
    id: 'sig-plan',
    name: '信号计划',
    watchlistId: 'sig-watch',
    rules: [
      {
        id: 'sig-rule',
        kind: 'strategy-signal',
        strategyId: 'sig-strategy',
        ruleId: 'entry',
        minScore: 60,
      },
    ],
    logic: 'ANY',
    triggerMode: 'on-enter',
    cooldownMinutes: 30,
    dailyNotificationLimit: 20,
    notifyOnRecovery: false,
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  });
};

describe('intraday-watch strategy-signal 规则', () => {
  it('当日信号命中：dry-run bootstrap 触发，方向取信号 bullish → buy', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedSignalSetup(ctx, T0);
    const r = await intradayWatchWorkflow.run({ alertPlanIds: ['sig-plan'], notify: false }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toHaveLength(1);
    const trigger = r.data.triggers[0];
    expect(trigger?.ruleKind).toBe('strategy-signal');
    expect(trigger?.direction).toBe('buy');
    expect(trigger?.reason).toContain('策略命中');
    expect(trigger?.evidence).toContain('放量突破');
  });

  it('历史信号（前一上海日）不进入信号窗口 → 不触发', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedSignalSetup(ctx, YESTERDAY);
    const r = await intradayWatchWorkflow.run({ alertPlanIds: ['sig-plan'], notify: false }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toEqual([]);
  });

  it('quote 缺失时触发不带 quote 字段，整轮不被不变量打断', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    await seedSignalSetup(base, T0);
    const ctx = withFixedQuoteAdapter(base, {});
    const r = await intradayWatchWorkflow.run(
      { alertPlanIds: ['sig-plan'], notify: false },
      ctx as ToolContext,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toHaveLength(1);
    const persisted = await base.repos.watchTrigger.listRecent({ poolId: 'sig-plan' });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.quote).toBeUndefined();
  });
});
