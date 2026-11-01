import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getAccountFactsTool } from './account-facts.js';
import { addHoldingTool } from './add-holding.js';
import { saveTradingPlanTool } from './trading-plan.js';

/**
 * P0-3（Codex 缺陷③）：并发冲突必须**结构化**传给调用方。
 *
 * 只返回一句泛化消息的话，client 只能靠正则猜「这是不是冲突」；
 * 而 Operation 链路会把 `invalid_input` 一并吞进通用失败分支，
 * 于是 `revisionConflictNotice` 成了接不通的 UI。
 */
const ACCOUNT_ID = 'a1b2c3d4-0001-4000-8000-000000000001';
const NOW = new Date('2026-09-09T02:00:00Z');

const plan = (digest: string, version: number) => ({
  id: `account:${ACCOUNT_ID}:stock:601398.SH`,
  version,
  accountId: ACCOUNT_ID,
  stockId: '601398.SH',
  stockName: '工商银行',
  industry: '银行',
  status: 'draft' as const,
  action: 'observe' as const,
  entryConditions: [],
  invalidEntryConditions: [],
  position: {
    currentPct: 0,
    targetPctRange: { min: 10, max: 12 },
    appliedPct: 10,
    fallbackPct: 10,
    rangePick: { ruleId: 'lower-bound' as const },
    constraintStatus: 'passed' as const,
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
  exit: { conditions: [], triggerConditions: [], canSellNow: false },
  validFrom: new Date(NOW.getTime() - 1000),
  validUntil: new Date(NOW.getTime() + 86_400_000),
  invalidationConditions: [],
  invalidationRules: [],
  accountFactsAsOf: NOW,
  accountFactsDigest: digest,
  marketFacts: [],
  evidence: [],
  source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
  explanation: {
    supportingEvidenceIds: [],
    counterEvidence: ['原反证'],
    risks: [],
    unknowns: [],
  },
  confidence: 50,
  createdAt: NOW,
});

describe('save_trading_plan 的冲突错误（P0-3）', () => {
  const setup = async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const facts = await getAccountFactsTool.execute({ accountId: ACCOUNT_ID }, ctx);
    if (!facts.ok) throw new Error('facts failed');
    return { ctx, digest: facts.data.facts.digest };
  };

  it('并发冲突 → invalid_input，但 issues 里带 reason=revision-conflict 与 actual', async () => {
    const { ctx, digest } = await setup();
    // v1 存成功
    expect((await saveTradingPlanTool.execute({ plan: plan(digest, 1) }, ctx)).ok).toBe(true);
    // 另一个会话存了 v2
    expect((await saveTradingPlanTool.execute({ plan: plan(digest, 2) }, ctx)).ok).toBe(true);
    // 基于 v1 的旧会话再存 v3 → 冲突
    const stale = await saveTradingPlanTool.execute(
      { plan: plan(digest, 3), expectedRevision: `account:${ACCOUNT_ID}:stock:601398.SH:v1` },
      ctx,
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.kind).toBe('invalid_input');
    const issues =
      (stale.error as { issues?: { path?: unknown[]; message?: string }[] }).issues ?? [];
    const byPath = (name: string) =>
      issues.find((issue) => Array.isArray(issue.path) && issue.path[0] === name)?.message;
    // 结构化字段：client 靠这两个值给出「你打开的是 vN / 当前已是 vN+1」。
    expect(byPath('reason')).toBe('revision-conflict');
    expect(byPath('actual')).toBe(`account:${ACCOUNT_ID}:stock:601398.SH:v2`);
  });

  it('结构化字段存在时，消息文案改掉也不影响识别（不靠正则）', async () => {
    const { ctx, digest } = await setup();
    await saveTradingPlanTool.execute({ plan: plan(digest, 1) }, ctx);
    await saveTradingPlanTool.execute({ plan: plan(digest, 2) }, ctx);
    const stale = await saveTradingPlanTool.execute(
      { plan: plan(digest, 3), expectedRevision: `account:${ACCOUNT_ID}:stock:601398.SH:v1` },
      ctx,
    );
    if (stale.ok) throw new Error('应当冲突');
    const issues =
      (stale.error as { issues?: { path?: unknown[]; message?: string }[] }).issues ?? [];
    // 只要 path 还在，即使 message 变成任意文案，client 仍能识别。
    expect(issues.some((issue) => issue.path?.[0] === 'reason')).toBe(true);
    expect(issues.some((issue) => issue.path?.[0] === 'actual')).toBe(true);
  });

  it('不传 expectedRevision 时行为不变（存量调用兼容）', async () => {
    const { ctx, digest } = await setup();
    expect((await saveTradingPlanTool.execute({ plan: plan(digest, 1) }, ctx)).ok).toBe(true);
    expect((await saveTradingPlanTool.execute({ plan: plan(digest, 2) }, ctx)).ok).toBe(true);
  });
});

// `addHoldingTool` 仅用于保持与同目录其它测试一致的 fixture 形态。
void addHoldingTool;
