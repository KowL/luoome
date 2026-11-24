import { TEST_ACCOUNT } from '@luoome/adapters/testing';
import { dateInShanghai, type StockBrief, StockBriefSchema } from '@luoome/core';
import { BRIEF_DISCLAIMER, getStockBriefTool } from '@luoome/toolkit/tools/get-stock-brief.js';
import { listStockBriefsTool } from '@luoome/toolkit/tools/list-stock-briefs.js';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';

const FIXED_NOW = new Date('2026-11-24T09:30:00Z');
const TRADING_DATE = dateInShanghai(FIXED_NOW);

const briefRow = (overrides: Record<string, unknown> = {}): StockBrief =>
  StockBriefSchema.parse({
    id: 'brief-1',
    tradingDate: TRADING_DATE,
    phase: 'post-market',
    accountId: TEST_ACCOUNT.id,
    stockId: '002594.SZ',
    source: 'scheduled',
    decision: 'hold',
    confidence: 50,
    horizon: 'short',
    quality: 'ai',
    adviceId: 'advice-1',
    factDigest: 'digest-abcdef0123456789',
    factsAsOf: FIXED_NOW,
    missing: [],
    dataSources: ['eastmoney'],
    llmHttpCalls: 1,
    llmPromptTokens: 1200,
    llmCompletionTokens: 600,
    llmReasoningTokens: 200,
    llmCostUsd: 0,
    validUntil: new Date('2026-11-30T09:00:00Z'),
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  });

/** 计数型适配器：证明只读工具不触发 LLM / 行情拉取。 */
const countingAdapters = (
  base: Awaited<ReturnType<typeof buildTestContext>>['adapters'],
): { adapters: typeof base; calls: { llm: number; market: number } } => {
  const calls = { llm: 0, market: 0 };
  const llm = {
    name: base.llm.name,
    generate: async () => {
      calls.llm += 1;
      throw new Error('read-only tool must not call llm');
    },
  };
  const market = new Proxy(base.market, {
    get: (target, prop) => {
      const value = Reflect.get(target, prop);
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          calls.market += 1;
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return { adapters: { ...base, llm, market }, calls };
};

describe('get_stock_brief', () => {
  it('按 stockId / date 查询，missing 与 quality 原样返回，且 wording 带免责声明', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    await ctx.repos.stockBrief.upsert(
      briefRow({
        quality: 'rule-only',
        decision: 'watch',
        adviceId: undefined,
        missing: [{ dimension: 'intraday', reason: '分时拉取失败：timeout' }],
      }),
    );

    const result = await getStockBriefTool.execute(
      { stockId: '002594.SZ', date: TRADING_DATE },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.brief?.quality).toBe('rule-only');
    expect(result.data.brief?.missing).toEqual([
      { dimension: 'intraday', reason: '分时拉取失败：timeout' },
    ]);
    expect(result.data.wording.label).toBe('规则观察（低置信）');
    expect(result.data.wording.isRuleOnly).toBe(true);
    expect(result.data.wording.disclaimer).toBe(BRIEF_DISCLAIMER);
    expect(result.data.warnings.join('；')).toContain('intraday');
    // 文案不含操作动词。
    const text = [
      result.data.wording.label,
      result.data.wording.detail,
      result.data.wording.disclaimer,
      ...result.data.warnings,
    ].join('\n');
    expect(text).not.toMatch(/建仓|加仓|减仓|清仓|买入|卖出|满仓/);
    expect(text).toContain('不构成投资建议');
  });

  it('decision → §12.2 展示文案映射', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const cases = [
      ['buy', '偏多信号'],
      ['sell', '偏空信号'],
      ['hold', '中性观察'],
      ['watch', '待确认观察'],
      ['avoid', '回避观察'],
    ] as const;
    for (const [decision, label] of cases) {
      await ctx.repos.stockBrief.upsert(
        briefRow({ id: `brief-${decision}`, decision, quality: 'partial' }),
      );
      const result = await getStockBriefTool.execute({ stockId: '002594.SZ' }, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.data.wording.label).toBe(label);
    }
  });

  it('无记录时返回 warnings 与「暂无观察」而不是生成', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    const { adapters, calls } = countingAdapters(ctx.adapters);
    const result = await getStockBriefTool.execute({ stockId: '002594.SZ' }, { ...ctx, adapters });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.brief).toBeUndefined();
    expect(result.data.wording.label).toBe('暂无观察');
    expect(result.data.warnings.length).toBeGreaterThan(0);
    expect(calls.llm).toBe(0);
    expect(calls.market).toBe(0);
  });

  it('AI brief 且对应建议仍可读时返回 advice', async () => {
    const ctx = await buildTestContext();
    const advice = (
      await ctx.repos.advice.query({ subjectId: '002594.SZ', includeExpired: true })
    )[0];
    expect(advice).toBeDefined();
    if (advice === undefined) return;
    await ctx.repos.stockBrief.upsert(
      StockBriefSchema.parse({ ...briefRow(), adviceId: advice.id }),
    );
    const result = await getStockBriefTool.execute({ stockId: '002594.SZ' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advice?.id).toBe(advice.id);
    expect(result.data.warnings.join('；')).not.toContain('不可读');
  });
});

describe('list_stock_briefs', () => {
  it('按 date / watchlistId / stockIds 查询并返回 coverage + budget', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
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
    await ctx.repos.watchlistMember.saveMember({
      id: 'member-002594',
      watchlistId: 'wl-1',
      stockId: '002594.SZ',
      stage: 'watching',
      priority: 'normal',
      firstAddedAt: now,
      lastActivityAt: now,
    });
    await ctx.repos.stockBrief.upsert(briefRow({ id: 'brief-a' }));
    await ctx.repos.stockBrief.upsert(
      briefRow({
        id: 'brief-b',
        stockId: '600519.SH',
        quality: 'rule-only',
        decision: 'watch',
        adviceId: undefined,
        missing: [{ dimension: 'news', reason: '未配置新闻数据源' }],
      }),
    );

    const all = await listStockBriefsTool.execute({ date: TRADING_DATE }, ctx);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.items).toHaveLength(2);
    expect(all.data.coverage.byQuality).toMatchObject({ ai: 1, ruleOnly: 1 });
    expect(all.data.coverage.missingDimensions).toEqual(['news']);
    expect(all.data.budget.limit.maxHttpCalls).toBe(16);
    expect(all.data.budget.tokens).toBe(4000);

    const byStock = await listStockBriefsTool.execute(
      { date: TRADING_DATE, stockIds: ['600519.SH'] },
      ctx,
    );
    expect(byStock.ok).toBe(true);
    if (!byStock.ok) return;
    expect(byStock.data.items.map((item) => item.stockId)).toEqual(['600519.SH']);
    expect(byStock.data.items[0]?.wording.label).toBe('规则观察（低置信）');

    const byWatchlist = await listStockBriefsTool.execute(
      { date: TRADING_DATE, watchlistId: 'wl-1' },
      ctx,
    );
    expect(byWatchlist.ok).toBe(true);
    if (!byWatchlist.ok) return;
    expect(byWatchlist.data.items.map((item) => item.stockId)).toEqual(['002594.SZ']);
  });

  it('只读：一次查询 0 次 LLM、0 次行情拉取', async () => {
    const ctx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    await ctx.repos.stockBrief.upsert(briefRow());
    const { adapters, calls } = countingAdapters(ctx.adapters);
    const result = await listStockBriefsTool.execute({}, { ...ctx, adapters });
    expect(result.ok).toBe(true);
    expect(calls.llm).toBe(0);
    expect(calls.market).toBe(0);
  });
});
