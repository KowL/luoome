import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeMarketAdapter, TEST_ACCOUNT } from '@luoome/adapters/testing';
import { dateInShanghai, money, type Quote, type ToolContext } from '@luoome/core';
import {
  DAILY_STOCK_BRIEFS_CONCURRENCY,
  generateStockBriefsTool,
} from '@luoome/plugin-analysis/tools/generate-stock-briefs.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginExecutionPolicy } from '../plugin-policy.js';
import { buildTestContext, createTestPluginControl } from '../testing/context.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const validAnalysis = (overrides: Record<string, unknown> = {}) => ({
  decision: 'hold' as const,
  confidence: 50,
  horizon: 'short' as const,
  reasoning: {
    premise: '今日无新增事实，维持原判断',
    evidence: ['close=105.8'],
    counterEvidence: ['若收盘跌破 100 条判断作废'],
  },
  risks: ['可能回调'],
  raw: 'raw',
  ...overrides,
});

/** LLM stub：记录调用次数与最大并发，可注入 token usage。 */
const countingLlm = () => {
  const state = { calls: 0, inFlight: 0, maxInFlight: 0, systems: [] as string[] };
  return {
    state,
    adapter: {
      name: 'counting-llm',
      generate: async <T>(request: { system: string }): Promise<T> => {
        state.calls += 1;
        state.systems.push(request.system);
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return validAnalysis({
            usage: {
              promptTokens: 1000,
              completionTokens: 500,
              reasoningTokens: 100,
              costUsd: 0,
            },
          }) as T;
        } finally {
          state.inFlight -= 1;
        }
      },
    },
  };
};

const withLlm = (ctx: ToolContext, adapter: { name: string; generate: unknown }): ToolContext =>
  ({ ...ctx, adapters: { ...ctx.adapters, llm: adapter } }) as ToolContext;

const seedWatchlist = async (ctx: ToolContext, stages: Record<string, string>) => {
  const now = ctx.clock();
  await ctx.repos.watchlist.save({
    id: 'wl-1',
    name: '测试关注池',
    kind: 'personal',
    membershipPolicy: 'manual',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  for (const [stockId, stage] of Object.entries(stages)) {
    await ctx.repos.watchlistMember.saveMember({
      id: `member-${stockId}`,
      watchlistId: 'wl-1',
      stockId,
      stage: stage as 'watching',
      priority: 'normal',
      firstAddedAt: now,
      lastActivityAt: now,
    });
  }
};

const briefsOf = (ctx: ToolContext, tradingDate: string) =>
  ctx.repos.stockBrief.findByDay({ tradingDate, accountId: TEST_ACCOUNT.id });

describe('generate_stock_briefs', () => {
  it('持仓在 digest 变化时进入 LLM；watching 只出规则观察', async () => {
    const base = await buildTestContext({ advices: [] });
    await seedWatchlist(base, { '000858.SZ': 'watching' });
    const { state, adapter } = countingLlm();
    const ctx = withLlm(base, adapter);
    const tradingDate = dateInShanghai(base.clock());

    const result = await generateStockBriefsTool.execute(
      { scope: 'all', tradingDate, maxBriefs: 8 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(state.calls).toBeGreaterThan(0);
    expect(state.calls).toBeLessThanOrEqual(8);

    const watchItem = result.data.items.find((item) => item.stockId === '000858.SZ');
    expect(watchItem?.action).toBe('rule-only');
    expect(watchItem?.quality).toBe('rule-only');

    const heldItem = result.data.items.find((item) => item.stockId === '002594.SZ');
    expect(heldItem?.action).toBe('llm');
    expect(heldItem?.quality).toBe('ai');
    expect(heldItem?.adviceId).toBeDefined();

    const briefs = await briefsOf(base, tradingDate);
    expect(briefs.some((brief) => brief.stockId === '002594.SZ' && brief.quality === 'ai')).toBe(
      true,
    );
    expect(
      briefs.some((brief) => brief.stockId === '000858.SZ' && brief.quality === 'rule-only'),
    ).toBe(true);
    // ai brief 必须带 adviceId（不变量）。
    for (const brief of briefs.filter((item) => item.quality === 'ai')) {
      expect(brief.adviceId).toBeDefined();
    }
    // summary / budget 的计量必须与 stock_briefs.llm_* 求和一致。
    const usage = await base.repos.stockBrief.sumUsage(tradingDate);
    expect(result.data.summary.llmHttpCalls).toBe(usage.httpCalls);
    expect(result.data.summary.tokens).toBe(
      usage.promptTokens + usage.completionTokens + usage.reasoningTokens,
    );
    expect(result.data.budget).toMatchObject({
      date: tradingDate,
      httpCalls: usage.httpCalls,
      tokens: usage.promptTokens + usage.completionTokens + usage.reasoningTokens,
      costUsd: usage.costUsd,
    });
  });

  it('失败后修复重试：2 次真实 HTTP，两次 usage 都写入同一条 ai brief', async () => {
    const base = await buildTestContext({ advices: [] });
    let calls = 0;
    const ctx = withLlm(base, {
      name: 'repair-once-llm',
      generate: async <T>(): Promise<T> => {
        calls += 1;
        return validAnalysis({
          ...(calls === 1 ? { confidence: 150 } : {}),
          usage: { promptTokens: 1000, completionTokens: 500, reasoningTokens: 100, costUsd: 0 },
        }) as T;
      },
    });
    const tradingDate = dateInShanghai(base.clock());

    const result = await generateStockBriefsTool.execute(
      { scope: 'stock', stockIds: ['002594.SZ'], tradingDate },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(2);
    expect(result.data.items[0]?.action).toBe('llm');
    expect(result.data.summary.llmHttpCalls).toBe(2);

    const briefs = await briefsOf(base, tradingDate);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]?.quality).toBe('ai');
    expect(briefs[0]?.llmHttpCalls).toBe(2);
    expect(briefs[0]?.llmPromptTokens).toBe(2000);
    expect(briefs[0]?.llmCompletionTokens).toBe(1000);
    expect(briefs[0]?.llmReasoningTokens).toBe(200);

    const usage = await base.repos.stockBrief.sumUsage(tradingDate);
    expect(result.data.summary.tokens).toBe(3200);
    expect(usage.httpCalls).toBe(2);
    expect(usage.promptTokens + usage.completionTokens + usage.reasoningTokens).toBe(3200);
  });

  it('幂等：同日同 digest 再跑 0 次 LLM，不重复写 advices', async () => {
    const fixedNow = new Date('2026-11-24T08:00:00Z');
    const base = await buildTestContext({ advices: [], clock: () => fixedNow });
    const { state, adapter } = countingLlm();
    const ctx = withLlm(base, adapter);
    const tradingDate = dateInShanghai(base.clock());
    const input = { scope: 'stock', stockIds: ['002594.SZ'], tradingDate } as const;

    const first = await generateStockBriefsTool.execute(input, ctx);
    expect(first.ok).toBe(true);
    const adviceIdsAfterFirst = (await base.repos.advice.query({ subjectId: '002594.SZ' })).map(
      (advice) => advice.id,
    );
    const callsAfterFirst = state.calls;
    expect(callsAfterFirst).toBe(1);

    const second = await generateStockBriefsTool.execute(input, ctx);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(state.calls).toBe(callsAfterFirst);
    expect(second.data.summary.skippedByDigest).toBe(1);
    expect(second.data.items[0]?.action).toBe('skip');
    const adviceIdsAfterSecond = (await base.repos.advice.query({ subjectId: '002594.SZ' })).map(
      (advice) => advice.id,
    );
    expect(adviceIdsAfterSecond).toEqual(adviceIdsAfterFirst);
    expect(await briefsOf(base, tradingDate)).toHaveLength(1);
  });

  it('skipUnchangedDigest=false 时持仓在同 digest 下仍进入 LLM', async () => {
    const base = await buildTestContext({ advices: [] });
    const { state, adapter } = countingLlm();
    const ctx = withLlm(base, adapter);
    const tradingDate = dateInShanghai(base.clock());
    const input = { scope: 'stock', stockIds: ['002594.SZ'], tradingDate } as const;

    const first = await generateStockBriefsTool.execute(input, ctx);
    expect(first.ok).toBe(true);
    const second = await generateStockBriefsTool.execute(
      { ...input, skipUnchangedDigest: false },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(state.calls).toBe(2);
    expect(second.data.items[0]?.action).toBe('llm');
    // 同日同阶段幂等：仍然只有一行 brief。
    expect(await briefsOf(base, tradingDate)).toHaveLength(1);
  });

  it('预算硬限：HTTP 将超限时停止并返回 rate_limited + 部分结果', async () => {
    const base = await buildTestContext({ advices: [] });
    const { state, adapter } = countingLlm();
    const ctx = withLlm(base, adapter);
    const tradingDate = dateInShanghai(base.clock());

    const result = await generateStockBriefsTool.execute(
      {
        scope: 'stock',
        stockIds: ['002594.SZ', '600519.SH', '300750.SZ'],
        tradingDate,
        maxHttpCalls: 2,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 预留 2 次/票：只允许 1 票进入 LLM，其余按规则观察。
    expect(state.calls).toBe(1);
    expect(result.data.degradation?.reason).toBe('rate_limited');
    expect(result.data.summary.budgetStopped).toBeGreaterThan(0);
    const completed = result.data.items.filter((item) => item.action === 'llm');
    expect(completed).toHaveLength(1);
    const stopped = result.data.items.filter((item) => item.action === 'budget-stopped');
    expect(stopped.length).toBeGreaterThan(0);
    // 已完成与预算停止的 brief 都仍在库里。
    const briefs = await briefsOf(base, tradingDate);
    expect(briefs).toHaveLength(3);
    expect(briefs.some((brief) => brief.quality === 'ai')).toBe(true);
    expect(
      briefs
        .filter((brief) => brief.quality === 'rule-only')
        .every((brief) => brief.missing.some((item) => item.dimension === 'budget')),
    ).toBe(true);
  });

  it('token 硬限同样生效', async () => {
    const base = await buildTestContext({ advices: [] });
    const { state, adapter } = countingLlm();
    const ctx = withLlm(base, adapter);
    const tradingDate = dateInShanghai(base.clock());
    const result = await generateStockBriefsTool.execute(
      {
        scope: 'stock',
        stockIds: ['002594.SZ', '600519.SH'],
        tradingDate,
        maxTokens: 100,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 单票 token 预估已超限：不发起任何 LLM，全部按规则观察。
    expect(state.calls).toBe(0);
    expect(result.data.degradation?.reason).toBe('rate_limited');
    expect(result.data.summary.budgetStopped).toBe(2);
    expect(result.data.items.every((item) => item.action === 'budget-stopped')).toBe(true);
    const briefs = await briefsOf(base, tradingDate);
    expect(briefs).toHaveLength(2);
    expect(briefs.every((brief) => brief.quality === 'rule-only')).toBe(true);
    expect(briefs.every((brief) => brief.missing.some((item) => item.dimension === 'budget'))).toBe(
      true,
    );
  });

  it('并发为 2：stub 记录的最大进行中调用数不超过上限（批次 P95 ≤ 6 min 目标）', async () => {
    const base = await buildTestContext({ advices: [] });
    const { state, adapter } = countingLlm();
    const ctx = withLlm(base, adapter);
    const tradingDate = dateInShanghai(base.clock());
    const result = await generateStockBriefsTool.execute(
      {
        scope: 'stock',
        stockIds: ['002594.SZ', '600519.SH', '300750.SZ', '600036.SH'],
        tradingDate,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(state.calls).toBe(4);
    expect(state.maxInFlight).toBeLessThanOrEqual(DAILY_STOCK_BRIEFS_CONCURRENCY);
    expect(state.maxInFlight).toBeGreaterThan(1);
  });

  it('输出 shapes：items + summary{llmHttpCalls,tokens,skippedByDigest,degraded} + coverage/budget', async () => {
    const base = await buildTestContext({ advices: [] });
    const { adapter } = countingLlm();
    const ctx = withLlm(base, adapter);
    const tradingDate = dateInShanghai(base.clock());
    const result = await generateStockBriefsTool.execute(
      { scope: 'stock', stockIds: ['002594.SZ'], tradingDate },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.summary).toMatchObject({
      llmHttpCalls: expect.any(Number),
      tokens: expect.any(Number),
      skippedByDigest: expect.any(Number),
      degraded: false,
    });
    expect(result.data.coverage).toEqual({
      holdings: expect.any(Number),
      watchlist: expect.any(Number),
      signals: expect.any(Number),
      candidates: expect.any(Number),
    });
    expect(result.data.budget.limit.maxHttpCalls).toBe(16);
    expect(result.data.budget.limit.maxTokens).toBe(90_000);
    expect(result.data.budget.limit.maxBriefs).toBe(8);
  });

  it('LLM 失败：该票只写 rule-only brief，不写 advices', async () => {
    const base = await buildTestContext({ advices: [] });
    const ctx = withLlm(base, {
      name: 'failing-llm',
      generate: async () => {
        throw new Error('upstream 502');
      },
    });
    const tradingDate = dateInShanghai(base.clock());
    const result = await generateStockBriefsTool.execute(
      { scope: 'stock', stockIds: ['002594.SZ'], tradingDate },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]?.action).toBe('rule-only');
    expect(await base.repos.advice.query({ subjectId: '002594.SZ' })).toHaveLength(0);
    const briefs = await briefsOf(base, tradingDate);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]?.quality).toBe('rule-only');
    expect(briefs[0]?.missing.some((item) => item.dimension === 'llm')).toBe(true);
  });

  it('行情不可用：写 unavailable brief 而不是编造结论', async () => {
    const base = await buildTestContext({ advices: [] });
    class BrokenQuoteMarket extends FakeMarketAdapter {
      override async fetchQuote(stockCode: string): Promise<Quote> {
        const quote = await super.fetchQuote(stockCode);
        return { ...quote, prevClose: undefined, open: money(0.01) };
      }
    }
    const ctx = withLlm(
      { ...base, adapters: { ...base.adapters, market: new BrokenQuoteMarket() } } as ToolContext,
      countingLlm().adapter,
    );
    const tradingDate = dateInShanghai(base.clock());
    const result = await generateStockBriefsTool.execute(
      { scope: 'stock', stockIds: ['002594.SZ'], tradingDate },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const briefs = await briefsOf(base, tradingDate);
    expect(briefs[0]?.quality).toBe('unavailable');
    expect(briefs[0]?.missing.some((item) => item.dimension === 'quote')).toBe(true);
  });

  it('phase=premarket：0 次 LLM，只写 rule-only brief，不写 advices', async () => {
    const base = await buildTestContext({ advices: [] });
    const { state, adapter } = countingLlm();
    const ctx = withLlm(base, adapter);
    const tradingDate = dateInShanghai(base.clock());

    const result = await generateStockBriefsTool.execute(
      { scope: 'all', phase: 'premarket', tradingDate },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(state.calls).toBe(0);
    expect(result.data.phase).toBe('premarket');
    expect(result.data.items.length).toBeGreaterThan(0);
    expect(result.data.items.some((item) => item.action === 'llm')).toBe(false);
    expect(
      result.data.items.every(
        (item) => item.action === 'rule-only' || item.action === 'unavailable',
      ),
    ).toBe(true);
    expect(result.data.summary.llmHttpCalls).toBe(0);
    expect(result.data.summary.tokens).toBe(0);
    expect(result.data.summary.llmBriefs).toBe(0);
    expect(result.data.summary.ruleOnlyBriefs).toBeGreaterThan(0);

    expect(await base.repos.advice.query({})).toHaveLength(0);
    const briefs = await briefsOf(base, tradingDate);
    expect(briefs.length).toBe(result.data.items.length);
    for (const brief of briefs) {
      expect(brief.phase).toBe('premarket');
      expect(['rule-only', 'unavailable']).toContain(brief.quality);
      expect(brief.llmHttpCalls).toBe(0);
      expect(brief.adviceId).toBeUndefined();
    }
  });

  it('business.analysis 未启用 → permission_denied（可见，不静默跳过）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-briefs-'));
    roots.push(root);
    const { store, set } = createTestPluginControl(root);
    const policy = createPluginExecutionPolicy(
      store,
      new Set(['read', 'advice', 'write', 'external']),
    );
    const base = await buildTestContext({ advices: [], executionPolicy: policy });
    const result = await generateStockBriefsTool.execute(
      { scope: 'stock', stockIds: ['002594.SZ'] },
      base,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('permission_denied');

    set('business.analysis', true);
    const enabled = await generateStockBriefsTool.execute(
      { scope: 'stock', stockIds: ['002594.SZ'] },
      base,
    );
    expect(enabled.ok).toBe(true);
  });
});
