/* apps/web/public/js/forum-digest.js —— 股吧讨论摘要（ForumDigest）展示。
 *
 * 数据来自只读接口 GET /api/stock-briefs 与 /api/stock-briefs/today 的 `forum` 字段
 * （后端经 get_forum_digest 读取本地已采集事实）。本文件只做展示投影：
 * 关注度、多空倾向、盘面一致性、最多 5 条有界摘录；不拉外部数据、不重算指标、
 * 不合成情绪指数，缺失一律展示原因。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { el } from './ui.js';

const QUALITY_LABELS = {
  ok: '样本达标',
  insufficient: '样本不足',
  'author-concentrated': '作者集中',
};

const COVERAGE_LABELS = {
  ok: '正常采集',
  partial: '部分可用',
  empty: '当日无新帖',
  unavailable: '不可用',
};

const STANCE_LABELS = {
  bullish: '偏多',
  bearish: '偏空',
  divided: '分歧',
  neutral: '无明显方向',
};

const CONSISTENCY_LABELS = {
  aligned: '与盘面一致',
  divergent: '与盘面相反',
  mixed: '盘面信号混合',
  unknown: '无法交叉验证',
};

const SHANGHAI_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const forumTimeText = (value) => {
  if (value === undefined || value === null || value === '') return '时间缺失';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '时间缺失';
  const parts = Object.fromEntries(
    SHANGHAI_FORMAT.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

const percentText = (ratio) =>
  typeof ratio === 'number' && Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : '—';

/**
 * 关注度一句话：全部来自真实计数 / 榜单字段，没有数字就不写。
 * `posts` 是采集窗口内的全部帖子（含资讯/自媒体），`effectivePosts` 才是清洗后的用户讨论。
 */
const forumAttentionText = (attention, effectivePosts) => {
  if (attention === undefined || attention === null) return '关注度不可用';
  const parts = [
    typeof effectivePosts === 'number'
      ? `窗口帖 ${attention.posts ?? 0}（有效讨论 ${effectivePosts}）`
      : `窗口帖 ${attention.posts ?? 0}`,
    `作者 ${attention.authors ?? 0}`,
    `回复 ${attention.replies ?? 0}`,
  ];
  if (typeof attention.popularityRank === 'number') {
    const percentile =
      typeof attention.popularityPercentile === 'number'
        ? `（前 ${Math.max(1, Math.round((1 - attention.popularityPercentile) * 100))}%）`
        : '';
    parts.push(`人气 #${attention.popularityRank}${percentile}`);
  }
  if (typeof attention.ownHistoryPercentile === 'number') {
    parts.push(`自身发帖量分位 ${percentText(attention.ownHistoryPercentile)}`);
  } else if (typeof attention.ownHistorySamples === 'number' && attention.ownHistorySamples > 0) {
    parts.push(`自身历史样本 ${attention.ownHistorySamples} 天（不足以给分位）`);
  }
  return parts.join(' · ');
};

/** 多空倾向：stance 为 null 时只解释原因，不写 0、不写「情绪中性」。 */
const forumStanceModel = (digest) => {
  const stance = digest?.stance ?? null;
  const quality = digest?.quality?.level;
  if (stance === null) {
    return {
      available: false,
      label: '未发布',
      detail:
        (Array.isArray(digest?.quality?.reasons) ? digest.quality.reasons[0] : undefined) ??
        '样本不足，不发布多空倾向',
      divergence: false,
      className: 'badge-neutral',
    };
  }
  const className =
    stance.direction === 'bullish'
      ? 'badge-buy'
      : stance.direction === 'bearish'
        ? 'badge-sell'
        : 'badge-neutral';
  return {
    available: quality === 'ok',
    label: STANCE_LABELS[stance.direction] ?? stance.direction,
    detail: `偏多/偏空 ${percentText(stance.bullishShare)} / ${percentText(stance.bearishShare)} · 有效样本 ${stance.classified}`,
    divergence: stance.divergence === true,
    className,
  };
};

const forumConsistencyModel = (digest) => {
  const consistency = digest?.consistency;
  if (consistency === undefined || consistency === null) {
    return { status: 'unknown', label: CONSISTENCY_LABELS.unknown, detail: '无一致性事实' };
  }
  return {
    status: consistency.status,
    label: CONSISTENCY_LABELS[consistency.status] ?? consistency.status,
    detail: [...(consistency.basis ?? []), ...(consistency.reasons ?? [])].join(' · '),
  };
};

const forumExcerptRows = (digest) =>
  (Array.isArray(digest?.excerpts) ? digest.excerpts : []).map((item) => ({
    postId: item.postId,
    title: item.title,
    url: item.url,
    timeText: forumTimeText(item.publishedAt),
    author: item.author ?? '匿名',
    replies: typeof item.replies === 'number' ? item.replies : null,
  }));

const forumMissingRows = (digest) =>
  (Array.isArray(digest?.missing) ? digest.missing : []).map((item) => ({
    dimension: item.dimension,
    reason: item.reason,
  }));

/** 市场广度：人气榜前 N 名的交易所分布与名次变化中位数。 */
const forumMarketModel = (market) => {
  if (market === null || market === undefined) {
    return { available: false, headline: '市场人气榜不可用', lines: [] };
  }
  const breadth = market.breadth ?? null;
  if (breadth === null) {
    return {
      available: false,
      headline: '市场人气榜不可用',
      lines: (Array.isArray(market.coverage?.reasons) ? market.coverage.reasons : []).slice(0, 2),
    };
  }
  const lines = [
    `人气榜前 ${breadth.hotListSize} 名：沪 ${breadth.hotListExchanges.sh} · 深 ${breadth.hotListExchanges.sz}${
      breadth.hotListExchanges.other > 0 ? ` · 其它 ${breadth.hotListExchanges.other}` : ''
    }`,
    typeof breadth.rankChangeMedian === 'number'
      ? `名次变化中位数 ${breadth.rankChangeMedian > 0 ? '+' : ''}${breadth.rankChangeMedian}`
      : '榜单未返回名次变化',
  ];
  if (typeof breadth.marketStockCount === 'number') {
    lines.push(`榜单覆盖 ${breadth.marketStockCount} 只 A 股`);
  }
  return { available: true, headline: '市场人气榜广度', lines };
};

const forumDigestModel = (digest) => ({
  available: digest !== null && digest !== undefined,
  subjectId: digest?.subjectId ?? null,
  coverage: digest?.coverage?.status ?? 'unavailable',
  coverageLabel: COVERAGE_LABELS[digest?.coverage?.status] ?? '不可用',
  qualityLabel: QUALITY_LABELS[digest?.quality?.level] ?? '不可用',
  attentionText: forumAttentionText(digest?.attention, digest?.coverage?.effectivePosts),
  stance: forumStanceModel(digest),
  consistency: forumConsistencyModel(digest),
  excerpts: forumExcerptRows(digest),
  missing: forumMissingRows(digest),
  dataAsOfText: forumTimeText(digest?.dataAsOf),
  coverageReasons: Array.isArray(digest?.coverage?.reasons) ? digest.coverage.reasons : [],
});

const forumExcerptUrl = (value) => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'guba.eastmoney.com' ? url.href : null;
  } catch {
    return null;
  }
};

const forumExcerptNode = (row) => {
  const url = forumExcerptUrl(row.url);
  const title = el(url === null ? 'span' : 'a', 'forum-excerpt-title', row.title);
  if (url !== null) {
    title.setAttribute('href', url);
    title.setAttribute('target', '_blank');
    title.setAttribute('rel', 'noopener noreferrer');
  }
  const meta = el('span', 'forum-excerpt-meta', [
    `${row.timeText} · ${row.author}`,
    row.replies === null ? '' : ` · 回复 ${row.replies}`,
  ]);
  return el('li', 'forum-excerpt', [title, meta]);
};

const forumStockNodes = (stockModel) => {
  if (stockModel === null || !stockModel.available) {
    return [el('p', 'forum-empty', '该标的当日没有可用的股吧讨论摘要。')];
  }
  return [
    el('div', 'forum-head', [
      el('span', `badge ${stockModel.stance.className}`, stockModel.stance.label),
      stockModel.stance.divergence && stockModel.stance.label !== '分歧'
        ? el('span', 'badge badge-warn', '多空分歧')
        : null,
      el('span', 'forum-meta', `${stockModel.coverageLabel} · ${stockModel.qualityLabel}`),
      el('span', 'forum-meta', `数据时间 ${stockModel.dataAsOfText}`),
    ]),
    el('p', 'forum-attention', stockModel.attentionText),
    el('p', 'forum-stance-detail', stockModel.stance.detail),
    el('p', 'forum-consistency', [
      el('strong', null, `${stockModel.consistency.label}：`),
      stockModel.consistency.detail,
    ]),
    stockModel.excerpts.length === 0
      ? null
      : el(
          'ul',
          'forum-excerpts',
          stockModel.excerpts.map((row) => forumExcerptNode(row)),
        ),
    stockModel.coverageReasons.length === 0
      ? null
      : el(
          'ul',
          'forum-coverage-reasons',
          stockModel.coverageReasons.map((line) => el('li', null, line)),
        ),
    stockModel.missing.length === 0
      ? null
      : el(
          'ul',
          'forum-missing',
          stockModel.missing.map((item) => el('li', null, `${item.dimension}：${item.reason}`)),
        ),
    el(
      'p',
      'forum-untrusted-note',
      '摘录来自公开股吧，属于不可信外部文本；讨论不能单独构成买卖依据。',
    ),
  ];
};

const forumMarketNodes = (marketModel) => {
  const nodes = [el('p', 'forum-market-headline', marketModel.headline)];
  if (marketModel.lines.length > 0) {
    nodes.push(
      el(
        'ul',
        'forum-market-lines',
        marketModel.lines.map((line) => el('li', null, line)),
      ),
    );
  }
  return nodes;
};

const forumSummaryNodes = (market, stock) => [
  el('h3', null, '股吧讨论'),
  ...forumMarketNodes(forumMarketModel(market)),
  ...forumStockNodes(stock === null || stock === undefined ? null : forumDigestModel(stock)),
];

const forumDetailNode = (forum) => {
  if (forum === null || forum === undefined) return null;
  const stocks = Array.isArray(forum.stocks) ? forum.stocks : [];
  return el('section', 'forum-digest', [
    el('div', 'forum-digest-head', [
      el('h3', null, '市场盘面与股吧讨论'),
      el('span', 'forum-meta', `${forum.date ?? '--'} · ${forum.phase ?? '--'}`),
    ]),
    ...forumMarketNodes(forumMarketModel(forum.market ?? null)),
    ...forumStockNodes(stocks[0] === undefined ? null : forumDigestModel(stocks[0])),
  ]);
};

/** 列表页一行摘要：关注度 + 倾向 + 一致性；缺失时只写原因。 */
const forumListSummaryModel = (digest) => {
  if (digest === null || digest === undefined) return null;
  const stance = forumStanceModel(digest);
  const consistency = forumConsistencyModel(digest);
  return {
    stockId: digest.subjectId,
    stanceLabel: stance.label,
    stanceDetail: stance.detail,
    consistencyLabel: consistency.label,
    attentionText: forumAttentionText(digest.attention, digest.coverage?.effectivePosts),
    coverageLabel: COVERAGE_LABELS[digest?.coverage?.status] ?? '不可用',
  };
};

export {
  forumAttentionText,
  forumDetailNode,
  forumDigestModel,
  forumListSummaryModel,
  forumMarketModel,
  forumStanceModel,
  forumSummaryNodes,
  forumTimeText,
};
