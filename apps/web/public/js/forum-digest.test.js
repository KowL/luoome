/* apps/web/public/js/forum-digest.test.js —— 股吧讨论摘要的前端投影与渲染。
 *
 * 只断言展示投影：关注度 / 多空倾向 / 盘面一致性 / 摘录上限 / 缺失原因，
 * 以及两个入口（个股详情卡、首页今日观察）确实消费同一份 forum 数据。
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  forumAttentionText,
  forumDetailNode,
  forumDigestModel,
  forumMarketModel,
  forumStanceModel,
  forumTimeText,
} from './forum-digest.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
}

const withFakeDom = (run) => {
  const previous = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = FakeNode;
  globalThis.document = {
    createElement: (tagName) => new FakeNode(tagName),
    createTextNode: (text) => ({ textContent: text }),
  };
  try {
    return run();
  } finally {
    globalThis.document = previous.document;
    globalThis.Node = previous.Node;
  }
};

const textOf = (node) => {
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  const own = typeof node.textContent === 'string' ? node.textContent : '';
  const children = Array.isArray(node.children) ? node.children : [];
  return own + children.map(textOf).join(' ');
};

const findTag = (node, tagName) => {
  if (node?.tagName === tagName) return node;
  for (const child of node?.children ?? []) {
    const found = findTag(child, tagName);
    if (found !== null) return found;
  }
  return null;
};

const marketDigest = (overrides = {}) => ({
  id: 'digest-market',
  subjectKind: 'market',
  subjectId: 'market',
  tradingDate: '2026-11-26',
  phase: 'post-market',
  source: 'eastmoney',
  dataAsOf: '2026-11-26T07:40:00Z',
  coverage: { status: 'ok', effectivePosts: 0, windowPosts: 0, reasons: [] },
  quality: { level: 'insufficient', reasons: ['市场级只采集人气榜广度'] },
  attention: { posts: 0, authors: 0, replies: 0, clicks: 0, likes: 0, topAuthorShare: 0 },
  breadth: {
    hotListSize: 100,
    hotListExchanges: { sh: 41, sz: 59, other: 0 },
    rankChangeMedian: 2,
    marketStockCount: 5581,
  },
  stance: null,
  excerpts: [],
  consistency: { status: 'unknown', basis: [], reasons: ['市场级不发布多空倾向'] },
  missing: [{ dimension: 'stance', reason: '市场级未采集逐帖样本' }],
  ...overrides,
});

const stockDigest = (overrides = {}) => ({
  id: 'digest-stock',
  subjectKind: 'stock',
  subjectId: '600519.SH',
  tradingDate: '2026-11-26',
  phase: 'post-market',
  source: 'eastmoney',
  dataAsOf: '2026-11-26T07:40:00Z',
  coverage: { status: 'ok', effectivePosts: 10, windowPosts: 12, reasons: [] },
  quality: { level: 'ok', reasons: [] },
  attention: {
    posts: 12,
    authors: 10,
    replies: 42,
    clicks: 1200,
    likes: 8,
    topAuthorShare: 0.2,
    popularityRank: 88,
    popularityPercentile: 0.98,
    ownHistoryPercentile: 0.75,
    ownHistorySamples: 20,
  },
  stance: {
    direction: 'bullish',
    bullish: 8,
    bearish: 2,
    classified: 10,
    bullishShare: 0.8,
    bearishShare: 0.2,
    divergence: false,
  },
  excerpts: [
    {
      postId: 'p-1',
      title: '收盘站上均线，明天看能否放量',
      url: 'https://guba.eastmoney.com/news,600519,12345.html',
      publishedAt: '2026-11-26T07:00:00Z',
      author: '吧友A',
      replies: 6,
      untrusted: true,
    },
  ],
  consistency: {
    status: 'aligned',
    basis: ['股吧偏多（偏多/偏空 80% / 20%）', '当日涨跌幅 +1.20%'],
    reasons: [],
  },
  missing: [],
  ...overrides,
});

describe('股吧讨论展示投影', () => {
  it('关注度只由真实计数与人气榜字段组成，没有数字就不编', () => {
    expect(forumAttentionText(stockDigest().attention, 10)).toBe(
      '窗口帖 12（有效讨论 10） · 作者 10 · 回复 42 · 人气 #88（前 2%） · 自身发帖量分位 75%',
    );
    expect(forumAttentionText({ posts: 3, authors: 2, replies: 0 })).toBe(
      '窗口帖 3 · 作者 2 · 回复 0',
    );
    expect(
      forumAttentionText({ posts: 1, authors: 1, replies: 0, ownHistorySamples: 2 }, 0),
    ).toContain('不足以给分位');
  });

  it('stance 为 null 时只解释原因，不写 0 或「情绪中性」', () => {
    const model = forumStanceModel({
      ...stockDigest(),
      stance: null,
      quality: { level: 'insufficient', reasons: ['有效用户帖 3 条，少于 8 条，不发布多空倾向'] },
    });
    expect(model.available).toBe(false);
    expect(model.label).toBe('未发布');
    expect(model.detail).toContain('少于 8 条');
  });

  it('标记分歧与盘面相反的方向', () => {
    expect(forumStanceModel(stockDigest()).className).toBe('badge-buy');
    const divergent = forumDigestModel(
      stockDigest({
        stance: { ...stockDigest().stance, divergence: true, direction: 'divided' },
        consistency: {
          status: 'divergent',
          basis: ['股吧偏多（偏多/偏空 80% / 20%）', '当日涨跌幅 -3.00%'],
          reasons: ['讨论方向与当日涨跌方向相反'],
        },
      }),
    );
    expect(divergent.stance.divergence).toBe(true);
    expect(divergent.consistency.label).toBe('与盘面相反');
    expect(divergent.consistency.detail).toContain('-3.00%');
  });

  it('市场广度展示交易所分布、名次中位数与覆盖股票数', () => {
    const model = forumMarketModel(marketDigest());
    expect(model.available).toBe(true);
    expect(model.lines[0]).toBe('人气榜前 100 名：沪 41 · 深 59');
    expect(model.lines[1]).toBe('名次变化中位数 +2');
    expect(model.lines[2]).toBe('榜单覆盖 5581 只 A 股');
    expect(forumMarketModel(null).headline).toBe('市场人气榜不可用');
  });

  it('时间按 Asia/Shanghai 展示，非法值不伪造', () => {
    expect(forumTimeText('2026-11-26T07:40:00Z')).toBe('11-26 15:40');
    expect(forumTimeText(null)).toBe('时间缺失');
    expect(forumTimeText('not-a-date')).toBe('时间缺失');
  });

  it('渲染市场广度 + 个股态度 + 一致性 + 摘录 + 不可信提示', () => {
    const html = withFakeDom(() =>
      textOf(
        forumDetailNode({
          date: '2026-11-26',
          phase: 'post-market',
          market: marketDigest(),
          stocks: [stockDigest()],
        }),
      ),
    );
    expect(html).toContain('市场盘面与股吧讨论');
    expect(html).toContain('人气榜前 100 名');
    expect(html).toContain('偏多');
    expect(html).toContain('与盘面一致');
    expect(html).toContain('收盘站上均线');
    expect(html).toContain('不可信外部文本');
    const link = withFakeDom(() =>
      findTag(
        forumDetailNode({
          date: '2026-11-26',
          phase: 'post-market',
          market: marketDigest(),
          stocks: [stockDigest()],
        }),
        'a',
      ),
    );
    expect(link.attributes.href).toBe('https://guba.eastmoney.com/news,600519,12345.html');
    expect(link.attributes.target).toBe('_blank');
    expect(link.attributes.rel).toBe('noopener noreferrer');
  });

  it('没有摘要时明确写没有，不渲染空态度', () => {
    const html = withFakeDom(() =>
      textOf(
        forumDetailNode({ date: '2026-11-26', phase: 'post-market', market: null, stocks: [] }),
      ),
    );
    expect(html).toContain('市场人气榜不可用');
    expect(html).toContain('没有可用的股吧讨论摘要');
    expect(html).not.toContain('偏多');
  });
});

describe('入口接线', () => {
  it('个股详情卡渲染 forum 区块，数据来自同一个 detail 响应', () => {
    const source = read('./stock-brief.js');
    expect(source).toContain(
      "import { forumDetailNode, forumListSummaryModel, forumMarketModel } from './forum-digest.js';",
    );
    expect(source).toContain('(view, forum = null)');
    expect(source).toContain('forumDetailNode(forum)');
    const market = read('./market.js');
    expect(market).toContain('stockBriefCardNode(view, state.briefData?.forum ?? null)');
  });

  it('首页今日观察只消费 today 响应里的 forum，不额外请求、不触发生成', () => {
    const source = read('./stock-brief.js');
    expect(source).toContain('forumMarketModel(list.forum?.market ?? null)');
    expect(source).toContain('list?.forum === undefined');
    expect(source).toContain('forumByStock');
    const pages = read('./pages.js');
    expect(pages).toContain("callApi('/api/stock-briefs/today'");
    expect(pages).not.toContain('get_forum_digest');
    expect(pages).not.toContain('collect_forum_digest');
  });
});
