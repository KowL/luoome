/**
 * 每日个股建议回归 fixture 集（design.md §9.3 / tasks.md P3-3）。
 *
 * 这里用真实调用固化 8 个必须长期绿的场景；改提示词、事实包或校验层时，本文件是
 * 需要同步更新的唯一清单：
 *
 * 1. 低开/高开        → `低开/高开：事实低开时输出「高开」被校验拦截`
 * 2. 26 vs 120 根     → `26 vs 120 根：MACD/MA60/穿越字段按样本数开关`
 * 3. 编造数字         → `编造数字：事实包外的数字被判违规`
 * 4. 截断空输出       → `截断空输出：空/截断内容不得当结论落库，降级 rule-only`
 * 5. 新闻缺失         → `新闻缺失：missing 带 news 维度与原因，brief 不编造新闻`
 * 6. 板块 502         → `板块 502：事实包降级不抛错并写明 reason`
 * 7. 账户 unavailable → `账户 unavailable：缺失账户降级为 unavailable 并带原因`
 * 8. 预算耗尽         → `预算耗尽：rate_limited + 部分结果，剩余按规则观察`
 *
 * 全部使用 mock 适配器与内存库，禁止真实网络与真实 LLM。
 */

import { FakeMarketAdapter, TEST_ACCOUNT } from '@luoome/adapters/testing';
import {
  type DailyBar,
  type DateRange,
  dateInShanghai,
  money,
  STANDARD_DISCLAIMERS,
  type ToolContext,
  type ToolContextMarketIntel,
} from '@luoome/core';
import {
  ANALYZE_STOCK_MAX_ATTEMPTS,
  analyzeStockTool,
} from '@luoome/plugin-analysis/tools/analyze-stock.js';
import { generateStockBriefsTool } from '@luoome/plugin-analysis/tools/generate-stock-briefs.js';
import { numericAuditViolations } from '@luoome/toolkit/internal/numeric-audit.js';
import {
  buildStockFactPack,
  deriveOpeningFact,
  summarizeFactPackForBrief,
} from '@luoome/toolkit/internal/stock-facts.js';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';

const STOCK_ID = '002594.SZ';

const audit = (premise: string, facts: unknown): readonly string[] =>
  numericAuditViolations({
    output: {
      decision: 'hold',
      confidence: 55,
      horizon: 'short',
      reasoning: { premise, evidence: [], counterEvidence: [] },
      risks: [],
    },
    facts,
    availableFields: [],
  });

const withLlm = (ctx: ToolContext, generate: (request: unknown) => Promise<unknown>): ToolContext =>
  ({
    ...ctx,
    adapters: {
      ...ctx.adapters,
      llm: { name: 'fixture-llm', generate },
    },
  }) as ToolContext;

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
  usage: { promptTokens: 1000, completionTokens: 500, reasoningTokens: 100, costUsd: 0 },
  raw: 'raw',
  ...overrides,
});

/** 固定 N 根日线的行情适配器（价量确定性）。 */
class BarsMarket extends FakeMarketAdapter {
  constructor(private readonly barsCount: number) {
    super();
  }

  override fetchDailyBars(stockCodeValue: string, range: DateRange): Promise<DailyBar[]> {
    const dayMs = 86_400_000;
    const bars: DailyBar[] = [];
    for (let back = this.barsCount - 1; back >= 0; back -= 1) {
      const index = this.barsCount - 1 - back;
      const close = money(100 + Math.sin(index / 7) * 5 + (index % 5) * 0.1);
      bars.push({
        stockId: stockCodeValue,
        date: new Date(range.end.getTime() - back * dayMs),
        open: money(close - 0.2),
        high: money(close + 0.5),
        low: money(close - 0.5),
        close,
        volume: 500_000 + index * 1_000,
        adjustment: 'qfq',
        source: 'fixture',
      });
    }
    return Promise.resolve(bars);
  }
}

describe('brief 回归 fixture 集', () => {
  it('低开/高开：事实低开时输出「高开」被校验拦截', () => {
    const facts = {
      quote: { open: money(1475.35), close: money(1480), prevClose: money(1485.75) },
      indicators: { ma20: 1470 },
      opening: deriveOpeningFact({ open: money(1475.35), prevClose: money(1485.75) }),
    };
    const violations = audit('今日高开，随后回落到 1475.35 附近。', facts).join('\n');
    expect(violations).toContain('开盘方向与事实不符');
    expect(violations).toContain('低开');
  });

  it('26 vs 120 根：MACD/MA60/穿越字段按样本数开关', async () => {
    const base = await buildTestContext({ advices: [] });
    const shortPack = await buildStockFactPack(
      { ...base, adapters: { ...base.adapters, market: new BarsMarket(26) } },
      { stockId: STOCK_ID, include: ['bars', 'indicators'] },
    );
    expect(shortPack?.bars?.status).toBe('ok');
    if (shortPack?.bars?.status === 'ok') {
      expect(shortPack.bars.data.requiredCount).toBe(120);
      expect(shortPack.bars.data.actualCount).toBe(26);
    }
    expect(shortPack?.indicators?.status).toBe('ok');
    if (shortPack?.indicators?.status === 'ok') {
      expect(shortPack.indicators.data.values.macdHist).toBeUndefined();
      expect(shortPack.indicators.data.values.ma60).toBeUndefined();
      expect(shortPack.indicators.data.values.daysSinceMa20CrossUp).toBeUndefined();
    }

    const fullPack = await buildStockFactPack(
      { ...base, adapters: { ...base.adapters, market: new BarsMarket(120) } },
      { stockId: STOCK_ID, include: ['bars', 'indicators'] },
    );
    expect(fullPack?.indicators?.status).toBe('ok');
    if (fullPack?.indicators?.status === 'ok') {
      expect(fullPack.indicators.data.values.macdHist).toBeTypeOf('number');
      expect(fullPack.indicators.data.values.ma60).toBeTypeOf('number');
      expect(fullPack.indicators.data.values.daysSinceMa20CrossUp).toBeTypeOf('number');
    }
    expect(fullPack?.factDigest).not.toBe(shortPack?.factDigest);
  });

  it('编造数字：事实包外的数字被判违规', () => {
    const facts = {
      quote: { open: money(104), close: money(105.8), prevClose: money(105.8) },
      indicators: { ma20: 100, high20: 108, low20: 96 },
      opening: deriveOpeningFact({ open: money(104), prevClose: money(105.8) }),
    };
    expect(audit('目标看到 1234.56。', facts).join('\n')).toContain('未在事实包或可派生范围内出现');
    expect(audit('收盘 105.8，较昨收变动 0%。', facts)).toEqual([]);
  });

  it('截断空输出：空/截断内容不得当结论落库，降级 rule-only', async () => {
    const base = await buildTestContext({ advices: [] });
    const outputs = ['', '   ', '{"decision":"hold","confidence":50'];
    let calls = 0;
    const ctx = withLlm(base, async () => {
      const raw = outputs[Math.min(calls, outputs.length - 1)] ?? '';
      calls += 1;
      return raw;
    });
    const tradingDate = dateInShanghai(base.clock());

    const result = await analyzeStockTool.execute(
      {
        stockId: STOCK_ID,
        brief: {
          tradingDate,
          phase: 'post-market',
          ruleOnlyDraft: {
            decision: 'hold',
            confidence: 20,
            premise: '中性观察：规则 fallback。仅技术研究，不构成投资建议。',
            evidence: ['规则 fallback：回归 fixture'],
            disclaimers: [...STANDARD_DISCLAIMERS],
          },
        },
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('llm_error');
    expect(calls).toBe(ANALYZE_STOCK_MAX_ATTEMPTS);
    expect(await base.repos.advice.query({ subjectId: STOCK_ID })).toHaveLength(0);

    const briefs = await base.repos.stockBrief.findByStock({
      stockId: STOCK_ID,
      accountId: TEST_ACCOUNT.id,
      tradingDate,
    });
    expect(briefs).toHaveLength(1);
    expect(briefs[0]?.quality).toBe('rule-only');
    expect(briefs[0]?.decision).toBe('hold');
    expect(briefs[0]?.adviceId).toBeUndefined();
    expect(briefs[0]?.missing.some((item) => item.dimension === 'llm')).toBe(true);
  });

  it('新闻缺失：missing 带 news 维度与原因，brief 不编造新闻', async () => {
    // 未注入 marketIntel.news：新闻段必须 unavailable 并写原因。
    const base = await buildTestContext({ advices: [] });
    const tradingDate = dateInShanghai(base.clock());

    const result = await generateStockBriefsTool.execute(
      { scope: 'stock', stockIds: [STOCK_ID], phase: 'premarket', tradingDate },
      base,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.summary.llmHttpCalls).toBe(0);

    const briefs = await base.repos.stockBrief.findByStock({
      stockId: STOCK_ID,
      accountId: TEST_ACCOUNT.id,
      tradingDate,
    });
    expect(briefs).toHaveLength(1);
    const news = briefs[0]?.missing.find((item) => item.dimension === 'news');
    expect(news).toBeDefined();
    expect(news?.reason.length).toBeGreaterThan(0);
    expect(news?.reason).toContain('未配置新闻数据源');
    expect(briefs[0]?.quality).not.toBe('ai');
  });

  it('板块 502：事实包降级不抛错并写明 reason', async () => {
    const base = await buildTestContext({ advices: [] });
    const marketIntel: ToolContextMarketIntel = {
      sectorQuote: {
        name: 'sector-quote',
        sources: ['eastmoney'],
        fetchList: async () => ({
          ok: false,
          error: {
            kind: 'adapter_error',
            adapter: 'sector-quote',
            message: 'eastmoney 502',
            recoverable: true,
          },
        }),
        status: () => [],
      },
    };
    const ctx = { ...base, adapters: { ...base.adapters, marketIntel } } as ToolContext;

    const pack = await buildStockFactPack(ctx, { stockId: STOCK_ID });
    expect(pack).not.toBeNull();
    if (pack === null) return;
    expect(pack.sectorQuote?.status).toBe('unavailable');
    if (pack.sectorQuote?.status === 'unavailable') {
      expect(pack.sectorQuote.reason).toContain('502');
    }
    expect(pack.sectors?.status).toBe('unavailable');
    if (pack.sectors?.status === 'unavailable') {
      expect(pack.sectors.reason).toContain('fuyao');
    }

    const summary = summarizeFactPackForBrief(pack, base.clock());
    const dimensions = summary.missing.map((item) => item.dimension);
    expect(dimensions).toContain('sector-quote');
    expect(dimensions).toContain('sector-membership');
  });

  it('账户 unavailable：缺失账户降级为 unavailable 并带原因', async () => {
    const base = await buildTestContext({ advices: [] });
    const pack = await buildStockFactPack(base, {
      stockId: STOCK_ID,
      accountId: 'missing-account',
      include: ['quote', 'account'],
    });
    expect(pack).not.toBeNull();
    if (pack === null) return;
    expect(pack.account?.status).toBe('unavailable');
    if (pack.account?.status === 'unavailable') {
      expect(pack.account.reason).toContain('账户');
    }
    const summary = summarizeFactPackForBrief(pack, base.clock());
    const account = summary.missing.find((item) => item.dimension === 'account');
    expect(account).toBeDefined();
    expect(account?.reason.length).toBeGreaterThan(0);
  });

  it('预算耗尽：rate_limited + 部分结果，剩余按规则观察', async () => {
    const base = await buildTestContext({ advices: [] });
    let calls = 0;
    const ctx = withLlm(base, async () => {
      calls += 1;
      return validAnalysis();
    });
    const tradingDate = dateInShanghai(base.clock());

    const result = await generateStockBriefsTool.execute(
      {
        scope: 'stock',
        stockIds: [STOCK_ID, '600519.SH', '300750.SZ'],
        tradingDate,
        maxHttpCalls: 2,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 每票预留 2 次 HTTP：只允许 1 票进入 LLM，其余按规则观察。
    expect(calls).toBe(1);
    expect(result.data.degradation?.reason).toBe('rate_limited');
    expect(result.data.summary.budgetStopped).toBeGreaterThan(0);
    expect(result.data.items.filter((item) => item.action === 'llm')).toHaveLength(1);
    expect(result.data.items.filter((item) => item.action === 'budget-stopped').length).toBe(
      result.data.summary.budgetStopped,
    );

    const briefs = await base.repos.stockBrief.findByDay({
      tradingDate,
      accountId: TEST_ACCOUNT.id,
    });
    expect(briefs).toHaveLength(3);
    expect(
      briefs
        .filter((brief) => brief.quality === 'rule-only')
        .every((brief) => brief.missing.some((item) => item.dimension === 'budget')),
    ).toBe(true);
  });
});
