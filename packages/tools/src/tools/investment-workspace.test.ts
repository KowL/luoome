import {
  type LLMAdapterLike,
  type StrategyDslV1,
  type StrategyRun,
  strategyDefinitionHash,
  type ToolContext,
} from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  getInvestmentCandidatesTool,
  getInvestmentWorkspaceTool,
  researchInvestmentDirectionsTool,
  saveInvestmentConsensusTool,
  setInvestmentTrackingTool,
} from './investment-workspace.js';
import { syncStrategyWatchlistSubscriptionsTool } from './strategy-watchlist-subscription.js';

const now = new Date('2026-10-16T08:00:00Z');
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
  signals: { entry: [], exit: [], risk: [] },
};
const modelAnswer = (strategyId: string) => ({
  strategyId,
  stance: 'observe',
  rationale: '仅观察规则覆盖范围内的机会。',
  comparisonReason: '覆盖事实合格，但没有收益证据，先观察。',
  evidenceIds: [`${strategyId}-run:coverage`],
  objections: [
    {
      kind: 'known-risk',
      conclusion: '反对据此立即买入。',
      evidenceIds: [`${strategyId}-run:selection`],
      risks: ['规则入选不代表未来收益。'],
      unknowns: ['个股事件风险尚未核验。'],
      reconsiderWhen: ['补充逐股研究与账户事实。'],
      alternatives: ['观察或暂缓。'],
    },
  ],
  risks: ['可能出现量价背离。'],
  waitFor: ['等待逐股建议的有效条件。'],
  abandonWhen: ['规则事实不再支持。'],
  reviewWhen: ['新事实或策略版本变化。'],
  horizon: 'short',
});

const seedStrategy = async (
  ctx: ToolContext,
  id = 'direction-a',
  stockIds = ['002594.SZ', '600519.SH'],
  overrides: Partial<StrategyRun> = {},
) => {
  await ctx.repos.strategy.create({
    id,
    name: id,
    description: '测试方向',
    owner: 'user',
    status: 'active',
    currentVersionId: `${id}-v1`,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.repos.strategy.createVersion({
    id: `${id}-v1`,
    strategyId: id,
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  });
  await ctx.repos.strategyRun.commitRun({
    run: {
      id: `${id}-run`,
      strategyId: id,
      strategyVersionId: `${id}-v1`,
      mode: 'scan',
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf: now,
      startedAt: now,
      finishedAt: now,
      status: 'complete',
      scope: 'operational',
      inputSnapshot: { stockIds, universeKind: 'explicit' },
      providerStatuses: [],
      summary: { selected: stockIds.length },
      publication: { status: 'published', reasons: [], decidedAt: now },
      ...overrides,
    },
    results: stockIds.map((stockId) => ({
      runId: `${id}-run`,
      stockId,
      selected: true,
      score: 60,
      evidence: [`${id}:rule:${stockId}`],
      ruleEvaluations: [],
      dataAsOf: now,
    })),
    signals: [],
  });
};

const fixture = async (ids = ['direction-a']) => {
  const base = await buildTestContext({ clock: () => now });
  for (const id of ids) await seedStrategy(base, id);
  const generate: LLMAdapterLike['generate'] = async <T>({
    data,
  }: Parameters<LLMAdapterLike['generate']>[0]): Promise<T> => {
    const supplied = data as { strategies: { id: string }[] };
    return { directions: supplied.strategies.map((strategy) => modelAnswer(strategy.id)) } as T;
  };
  const tracked = vi.fn(generate);
  const ctx: ToolContext = {
    ...base,
    adapters: {
      ...base.adapters,
      llm: { name: 'test-only', generate: tracked as LLMAdapterLike['generate'] },
    },
  };
  return ctx;
};

const research = async (ctx: ToolContext) => {
  const result = await researchInvestmentDirectionsTool.execute(
    { requestId: 'research-1', question: '比较已发布的方向' },
    ctx,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  expect(result.data.research.status).toBe('complete');
  return result.data.research;
};
const saveInput = (result: Awaited<ReturnType<typeof research>>) => ({
  requestId: 'confirm-1',
  expectedVersion: 0,
  changes: {
    selections: result.directions.map((direction, index) => ({
      researchId: result.id,
      directionId: direction.id,
      role: index === 0 ? 'primary' : 'observe',
      userReason: '保留反对，先观察。',
    })),
    constraints: ['不自动交易'],
  },
  source: { userText: '以第一个方向为主，其它观察' },
  changeNote: '确认范围',
  reviewAt: new Date('2026-10-20T08:00:00Z'),
  validUntil: new Date('2026-10-23T08:00:00Z'),
});

describe('investment directions and consensus tools', () => {
  it('grounds directions and objections in the actual published scope, preserves dissent, and replays without another model call', async () => {
    const ctx = await fixture();
    const result = await research(ctx);
    expect(result.directions[0]?.coverage).toMatchObject({
      kind: 'explicit-subset',
      universeCount: 2,
      selectedCount: 2,
    });
    expect(result.directions[0]?.objections.map((item) => item.kind)).toContain('missing-evidence');
    expect(result.directions[0]?.accountFit).toBe('research-only');
    expect(result.createdAt).toEqual(now);
    const replay = await researchInvestmentDirectionsTool.execute(
      { requestId: 'research-1', question: '比较已发布的方向' },
      ctx,
    );
    expect(replay).toMatchObject({
      ok: true,
      data: { replayed: true, research: { id: result.id } },
    });
    expect(ctx.adapters.llm.generate).toHaveBeenCalledTimes(1);
    const saved = await saveInvestmentConsensusTool.execute(saveInput(result), ctx);
    expect(saved).toMatchObject({
      ok: true,
      data: { consensus: { version: 1, effectScope: 'future-research-only' }, tracking: null },
    });
    if (!saved.ok) return;
    expect(saved.data.consensus.selections[0]?.direction.objections[0]?.conclusion).toBe(
      '反对据此立即买入。',
    );
    expect(saved.data.consensus.selections[0]?.userReason).toBe('保留反对，先观察。');
    expect(await ctx.repos.tradingPlan.list({ accountId: ctx.user.defaultAccountId })).toEqual([]);
  });

  it('does not invoke the model for stale, withheld or unavailable facts; never turns no-data into no-opportunity', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedStrategy(ctx, 'stale-direction', ['002594.SZ'], {
      dataAsOf: new Date('2026-10-12T08:00:00Z'),
    });
    const spy = vi.spyOn(ctx.adapters.llm, 'generate');
    const result = await researchInvestmentDirectionsTool.execute(
      { requestId: 'no-data', question: '研究', strategyIds: ['stale-direction'] },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      data: { research: { status: 'unavailable', directions: [] } },
    });
    if (result.ok)
      expect(result.data.research.limitations.join(' ')).toContain('不代表没有市场机会');
    expect(spy).not.toHaveBeenCalled();
  });

  it('uses the complete recorded strategy scope even when it exceeds fifty stocks', async () => {
    const base = await buildTestContext({ clock: () => now });
    const stockIds = Array.from(
      { length: 60 },
      (_, index) => `${String(index + 1).padStart(6, '0')}.SZ`,
    );
    await seedStrategy(base, 'large-direction', stockIds);
    const generate: LLMAdapterLike['generate'] = async <T>() =>
      ({ directions: [modelAnswer('large-direction')] }) as T;
    const ctx = { ...base, adapters: { ...base.adapters, llm: { name: 'test-only', generate } } };
    const result = await researchInvestmentDirectionsTool.execute(
      { requestId: 'complete-scope', question: '研究显式范围', strategyIds: ['large-direction'] },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        research: {
          status: 'complete',
          directions: [
            {
              coverage: {
                kind: 'explicit-subset',
                universeCount: 60,
                evaluatedCount: 60,
                selectedCount: 60,
              },
            },
          ],
        },
      },
    });
  });

  it('saves the question and actual facts on model failure or fabricated evidence, without returning a conclusion', async () => {
    const ctx = await fixture();
    const bad: ToolContext = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        llm: {
          name: 'test-only',
          generate: async <T>() =>
            ({
              directions: [{ ...modelAnswer('direction-a'), evidenceIds: ['fabricated-fact'] }],
            }) as T,
        },
      },
    };
    const result = await researchInvestmentDirectionsTool.execute(
      { requestId: 'bad-model', question: '有何方向' },
      bad,
    );
    expect(result).toMatchObject({
      ok: true,
      data: { research: { status: 'failed', question: '有何方向', directions: [] } },
    });
    const state = await getInvestmentWorkspaceTool.execute({}, bad);
    expect(state).toMatchObject({ ok: true, data: { research: { status: 'failed' } } });
  });

  it('rejects foreign research and forged discussion sources, with no consensus write', async () => {
    const ctx = await fixture();
    const result = await research(ctx);
    const foreign = { ...ctx, user: { ...ctx.user, id: 'foreign-user' } };
    expect(await saveInvestmentConsensusTool.execute(saveInput(result), foreign)).toMatchObject({
      ok: false,
      error: { kind: 'not_found' },
    });
    await ctx.repos.chat.saveSession({
      id: 'foreign-chat',
      accountId: 'foreign-account',
      title: '私有',
      createdAt: now,
      updatedAt: now,
    });
    const forged = await saveInvestmentConsensusTool.execute(
      {
        ...saveInput(result),
        source: { userText: '坚持', sessionId: 'foreign-chat', messageId: 'unknown' },
      },
      ctx,
    );
    expect(forged).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    expect(await getInvestmentWorkspaceTool.execute({}, ctx)).toMatchObject({
      ok: true,
      data: { consensus: null },
    });
  });

  it('preserves omitted fields, rejects stale confirmation and restores confirmed memory after deleting chat', async () => {
    const ctx = await fixture();
    const result = await research(ctx);
    const source = { userText: '先观察', sessionId: 'chat-one', messageId: 'user-one' };
    await ctx.repos.chat.saveSession({
      id: source.sessionId,
      accountId: ctx.user.defaultAccountId,
      title: '方向讨论',
      createdAt: now,
      updatedAt: now,
    });
    await ctx.repos.chat.saveMessage({
      id: source.messageId,
      sessionId: source.sessionId,
      role: 'user',
      parts: [{ type: 'text', text: source.userText }],
      createdAt: now,
    });
    const first = { ...saveInput(result), source };
    expect((await saveInvestmentConsensusTool.execute(first, ctx)).ok).toBe(true);
    await ctx.repos.chat.removeSession(source.sessionId);
    const revised = await saveInvestmentConsensusTool.execute(
      {
        ...first,
        requestId: 'confirm-2',
        expectedVersion: 1,
        changes: {
          recentIntent: {
            mode: 'cautious',
            note: '最近谨慎',
            startsAt: now,
            reviewAt: new Date('2026-10-19T08:00:00Z'),
          },
        },
        source: { userText: '最近谨慎' },
      },
      ctx,
    );
    expect(revised).toMatchObject({
      ok: true,
      data: { consensus: { version: 2, constraints: ['不自动交易'] } },
    });
    expect(
      await saveInvestmentConsensusTool.execute(
        { ...first, requestId: 'stale-confirm', source: { userText: '重新确认旧版本' } },
        ctx,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: 'invariant_violation',
        message: expect.stringContaining('consensus_version_conflict'),
      },
    });
    const nextDay = { ...ctx, clock: () => new Date('2026-10-17T02:00:00Z') };
    const state = await getInvestmentWorkspaceTool.execute({}, nextDay);
    expect(state).toMatchObject({
      ok: true,
      data: {
        consensus: { version: 2 },
        effectiveIntent: { mode: 'cautious' },
        history: [{ version: 2 }, { version: 1, source }],
      },
    });
    const replay = await saveInvestmentConsensusTool.execute(first, ctx);
    expect(replay).toMatchObject({ ok: true, data: { replayed: true, consensus: { version: 1 } } });
  });

  it('merges the same stock from multiple directions and provides real existing research inputs', async () => {
    const ctx = await fixture(['direction-a', 'direction-b']);
    const result = await research(ctx);
    expect((await saveInvestmentConsensusTool.execute(saveInput(result), ctx)).ok).toBe(true);
    const candidates = await getInvestmentCandidatesTool.execute({ limit: 1 }, ctx);
    expect(candidates).toMatchObject({
      ok: true,
      data: { consensusVersion: 1, total: 2, truncated: true },
    });
    if (!candidates.ok) return;
    expect(candidates.data.candidates[0]?.directions).toHaveLength(2);
    expect(candidates.data.candidates[0]?.directions[0]?.researchInput).toEqual({
      strategyId: 'direction-a',
      runId: 'direction-a-run',
      stockId: '002594.SZ',
    });
  });

  it('keeps confirmed plan conflicts distinct from known risks and missing evidence when the user insists', async () => {
    const ctx = await fixture();
    const initial = await research(ctx);
    const input = saveInput(initial);
    const avoid = {
      ...input,
      changes: {
        ...input.changes,
        selections: input.changes.selections.map((selection) => ({ ...selection, role: 'avoid' })),
      },
    };
    expect((await saveInvestmentConsensusTool.execute(avoid, ctx)).ok).toBe(true);
    const proposed = await researchInvestmentDirectionsTool.execute(
      { requestId: 'reconsider', question: '我仍希望观察，重新比较证据' },
      ctx,
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.data.research.status).toBe('complete');
    expect(
      proposed.data.research.directions[0]?.objections.map((objection) => objection.kind),
    ).toEqual(expect.arrayContaining(['known-risk', 'missing-evidence', 'plan-conflict']));
    const revision = {
      ...saveInput(proposed.data.research),
      requestId: 'insist-confirmed',
      expectedVersion: 1,
      source: { userText: '保留你的反对，但我选择继续观察' },
    };
    const confirmed = await saveInvestmentConsensusTool.execute(revision, ctx);
    expect(confirmed).toMatchObject({
      ok: true,
      data: {
        consensus: {
          version: 2,
          selections: [
            { userReason: '保留反对，先观察。', direction: { accountFit: 'research-only' } },
          ],
        },
      },
    });
    if (confirmed.ok)
      expect(
        confirmed.data.consensus.selections[0]?.direction.objections.map(
          (objection) => objection.kind,
        ),
      ).toContain('plan-conflict');
  });

  it('separates a saved consensus from failed tracking, retries idempotently, and pauses only its own candidates', async () => {
    const ctx = await fixture();
    const result = await research(ctx);
    expect((await saveInvestmentConsensusTool.execute(saveInput(result), ctx)).ok).toBe(true);
    const holdings = await ctx.repos.holding.listByAccount(ctx.user.defaultAccountId);
    const failure = vi
      .spyOn(ctx.repos.watchlist, 'save')
      .mockRejectedValueOnce(new Error('test write failure'));
    const failed = await setInvestmentTrackingTool.execute(
      { requestId: 'track-failed', expectedVersion: 1, action: 'start' },
      ctx,
    );
    expect(failed).toMatchObject({ ok: true, data: { tracking: { status: 'failed' } } });
    failure.mockRestore();
    const started = await setInvestmentTrackingTool.execute(
      { requestId: 'track-retry', expectedVersion: 1, action: 'start' },
      ctx,
    );
    expect(started).toMatchObject({ ok: true, data: { tracking: { status: 'partial' } } });
    if (!started.ok) return;
    const watchlistId = started.data.tracking.items.find(
      (item) => item.status === 'tracking',
    )?.watchlistId;
    expect(watchlistId).toBeDefined();
    if (watchlistId === undefined) return;
    expect(await ctx.repos.watchlistMember.listMembers(watchlistId)).toHaveLength(2);
    const replay = await setInvestmentTrackingTool.execute(
      { requestId: 'track-retry', expectedVersion: 1, action: 'start' },
      ctx,
    );
    expect(replay).toMatchObject({ ok: true, data: { replayed: true } });
    expect(
      await ctx.repos.strategyWatchlistSubscription.list({ watchlistId, status: 'active' }),
    ).toHaveLength(1);
    const paused = await saveInvestmentConsensusTool.execute(
      {
        ...saveInput(result),
        requestId: 'pause-new',
        expectedVersion: 1,
        changes: {
          recentIntent: {
            mode: 'pause-new-opportunities',
            note: '先管持仓',
            startsAt: now,
            reviewAt: new Date('2026-10-19T08:00:00Z'),
          },
        },
      },
      ctx,
    );
    expect(paused).toMatchObject({
      ok: true,
      data: { consensus: { version: 2 }, tracking: { status: 'paused' } },
    });
    expect(
      await ctx.repos.strategyWatchlistSubscription.findActive({
        strategyId: 'direction-a',
        watchlistId,
      }),
    ).toBeNull();
    expect(await ctx.repos.holding.listByAccount(ctx.user.defaultAccountId)).toEqual(holdings);
    expect(await getInvestmentCandidatesTool.execute({}, ctx)).toMatchObject({
      ok: true,
      data: { candidates: [] },
    });
    expect(await getInvestmentWorkspaceTool.execute({}, ctx)).toMatchObject({
      ok: true,
      data: {
        trackingEligibility: { eligible: false, reason: expect.stringContaining('暂停新机会') },
      },
    });
    expect(
      await setInvestmentTrackingTool.execute(
        { requestId: 'forbidden-restart', expectedVersion: 2, action: 'start' },
        ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });

  it('binds background sync to the confirmed owner, version and review deadline, and reports current schedule drift', async () => {
    const ctx = await fixture();
    const result = await research(ctx);
    await saveInvestmentConsensusTool.execute(saveInput(result), ctx);
    const schedule = {
      id: 'direction-schedule',
      strategyId: 'direction-a',
      cron: '30 16 * * 1-5',
      timezone: 'Asia/Shanghai',
      enabled: true,
      nextRunAt: new Date('2026-10-19T08:30:00Z'),
      createdAt: now,
      updatedAt: now,
    };
    await ctx.repos.strategySchedule.save(schedule);
    const started = await setInvestmentTrackingTool.execute(
      { requestId: 'scheduled-track', expectedVersion: 1, action: 'start' },
      ctx,
    );
    expect(started).toMatchObject({ ok: true, data: { tracking: { status: 'tracking' } } });
    const synced = await syncStrategyWatchlistSubscriptionsTool.execute(
      { strategyId: 'direction-a', producerRunId: 'direction-a-run' },
      ctx,
    );
    expect(synced).toMatchObject({ ok: true, data: { complete: 1 } });
    await ctx.repos.strategySchedule.save({ ...schedule, enabled: false, nextRunAt: undefined });
    expect(await getInvestmentWorkspaceTool.execute({}, ctx)).toMatchObject({
      ok: true,
      data: { tracking: { status: 'partial' } },
    });
    const expired = { ...ctx, clock: () => new Date('2026-10-20T08:00:00Z') };
    expect(
      await syncStrategyWatchlistSubscriptionsTool.execute(
        { strategyId: 'direction-a', producerRunId: 'direction-a-run' },
        expired,
      ),
    ).toMatchObject({ ok: true, data: { status: 'skipped', skipped: 1, complete: 0 } });
    const foreign = { ...ctx, user: { ...ctx.user, id: 'other-owner' } };
    expect(
      await syncStrategyWatchlistSubscriptionsTool.execute(
        { strategyId: 'direction-a', producerRunId: 'direction-a-run' },
        foreign,
      ),
    ).toMatchObject({ ok: true, data: { status: 'skipped', skipped: 1 } });
    await ctx.repos.strategy.createVersion({
      id: 'direction-a-v2',
      strategyId: 'direction-a',
      version: 2,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      createdAt: now,
    });
    await ctx.repos.strategy.publishVersion('direction-a', 'direction-a-v2', now);
    expect(
      await syncStrategyWatchlistSubscriptionsTool.execute(
        { strategyId: 'direction-a', producerRunId: 'direction-a-run' },
        ctx,
      ),
    ).toMatchObject({ ok: true, data: { status: 'skipped', skipped: 1 } });
    expect(await getInvestmentWorkspaceTool.execute({}, ctx)).toMatchObject({
      ok: true,
      data: { consensusState: 'review-required', tracking: { status: 'paused' } },
    });
    expect(await getInvestmentCandidatesTool.execute({}, ctx)).toMatchObject({
      ok: true,
      data: { candidates: [] },
    });
  });

  it('allows explicit pause to recover an audited stale starting attempt, while blocking blind or early replay', async () => {
    const ctx = await fixture();
    const result = await research(ctx);
    await saveInvestmentConsensusTool.execute(saveInput(result), ctx);
    const attempt = {
      id: 'interrupted-attempt',
      ownerUserId: ctx.user.id,
      accountId: ctx.user.defaultAccountId,
      consensusVersion: 1,
      requestId: 'interrupted-request',
      requestHash: 'interrupted-hash',
      action: 'start' as const,
      status: 'starting' as const,
      items: [],
      startedAt: now,
      finishedAt: null,
    };
    await ctx.repos.investmentWorkspace.claimTracking(attempt);
    expect(
      await setInvestmentTrackingTool.execute(
        { requestId: 'blind', expectedVersion: 1, action: 'start' },
        ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'invariant_violation' } });
    expect(
      await setInvestmentTrackingTool.execute(
        { requestId: 'early', expectedVersion: 1, action: 'pause', recoverAttemptId: attempt.id },
        ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    const later = { ...ctx, clock: () => new Date(now.getTime() + 6 * 60_000) };
    const recovered = await setInvestmentTrackingTool.execute(
      {
        requestId: 'confirmed-recovery',
        expectedVersion: 1,
        action: 'pause',
        recoverAttemptId: attempt.id,
      },
      later,
    );
    expect(recovered).toMatchObject({ ok: true, data: { tracking: { status: 'paused' } } });
    await expect(
      ctx.repos.investmentWorkspace.finishTracking({
        ...attempt,
        status: 'tracking',
        finishedAt: later.clock(),
      }),
    ).rejects.toThrow('tracking_claim_conflict');
    expect(
      await setInvestmentTrackingTool.execute(
        { requestId: 'after-recovery', expectedVersion: 1, action: 'start' },
        later,
      ),
    ).toMatchObject({ ok: true, data: { tracking: { status: 'partial' } } });
  });
});
