/* apps/web/public/js/dashboard-market.js —— 看盘页市场行情区块。
 *
 * 布局对齐参考设计（finance-workbench Dashboard）：市场概览统计卡 + 迷你板块热力 + 财经要闻。
 * - 指数卡片由既有 #dashboard-indices 指数条承担（renderDashboard 内 5s 轮询）
 * - 本模块三个区块只在进入 dashboard 路由时加载一次（showRoute 调用），
 *   不进 5s 轮询：情绪 / 板块 / 新闻都是外部源调用，高频轮询会打爆上游
 * - 每个区块独立降级：单个失败只显示占位文案，不影响其它区块与下方既有卡片
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { renderSectorHeatmap } from './sector-heatmap.js';
import { $, el, mount } from './ui.js';

/** 今日（Asia/Shanghai）YYYY-MM-DD。 */
const shanghaiToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

/** 前一自然日（YYYY-MM-DD）。 */
const prevDay = (date) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/**
 * 首个探测日（Asia/Shanghai）：周末直接回退到周五，避免已知必败的 400 探测；
 * 法定节假日仍由 fetchSentimentSnapshot 的逐日回退兜底。
 */
const firstProbeDay = (date = shanghaiToday()) => {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 6) return prevDay(date); // 周六 → 周五
  if (weekday === 0) return prevDay(prevDay(date)); // 周日 → 周五
  return date;
};

/**
 * 相对时间（纯函数，dashboard-market.test.js 单测）：
 * <60s 刚刚；<60min N 分钟前；<24h N 小时前；<7d N 天前；否则 YYYY-MM-DD。
 */
const fmtRelativeTime = (d, now = new Date()) => {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '--';
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return '刚刚';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
};

/* ---- 市场概览（get_ashare_sentiment 情绪快照） ---- */

/**
 * 情绪快照 → 概览统计（纯函数）。维度 unavailable / 字段缺失时对应项为 null，渲染 '--'。
 */
const overviewStats = (snapshot) => {
  const breadth = snapshot?.breadth?.value ?? null;
  const limitUp = snapshot?.limitUp?.value ?? null;
  return {
    advancing: breadth?.advancing ?? null,
    declining: breadth?.declining ?? null,
    sealed: limitUp?.sealedCount ?? null,
    maxLadderLevel: limitUp?.maxLadderLevel ?? null,
    brokenRate: limitUp?.brokenRate ?? null,
    brokenCount: limitUp?.brokenCount ?? null,
  };
};

const setStat = (id, value) => {
  const node = $(`#${id}`);
  if (node !== null) node.textContent = value === null ? '--' : String(value);
};

/**
 * 拉情绪快照：非交易日（周末/节假日）回退到最近可确认的交易日（至多 7 天），
 * 与涨停梯队 compare 的回退策略一致；非 invalid_input 失败立即放弃（保留 '--' 占位）。
 */
const fetchSentimentSnapshot = async () => {
  let day = firstProbeDay();
  for (let i = 0; i < 7; i += 1) {
    // 循环内逐日探测，必须串行（后一天依赖前一天结果）
    const r = await callApi('/api/tools/get_ashare_sentiment/call', {
      method: 'POST',
      body: JSON.stringify({ input: { date: day, includeIndexes: false } }),
    });
    if (r.ok && r.data?.snapshot !== undefined) return r.data.snapshot;
    if (r.error?.kind !== 'invalid_input') return null;
    day = prevDay(day);
  }
  return null;
};

const renderOverview = async () => {
  const snapshot = await fetchSentimentSnapshot();
  if (snapshot === null || snapshot === undefined) return; // 保留 '--' 占位
  const stats = overviewStats(snapshot);
  setStat('dash-advancing', stats.advancing);
  setStat('dash-declining', stats.declining);
  setStat('dash-sealed', stats.sealed);
  setStat('dash-ladder', stats.maxLadderLevel === null ? '--' : `最高 ${stats.maxLadderLevel} 板`);
  setStat(
    'dash-broken-rate',
    stats.brokenRate === null ? '--' : `${(stats.brokenRate * 100).toFixed(1)}%`,
  );
  setStat('dash-broken-count', stats.brokenCount === null ? '--' : `炸板 ${stats.brokenCount}`);
};

/* ---- 行业板块迷你热力（点击跳 #sectors 页） ---- */

const renderMiniHeatmap = async () => {
  const wrap = $('#dash-sector-heatmap');
  if (wrap === null) return;
  const r = await callApi('/api/market/sectors?sort=changePct&limit=24');
  if (!r.ok) {
    mount(
      wrap,
      el(
        'p',
        'placeholder',
        `板块数据加载失败（${r.error?.kind ?? 'internal'}），稍后可到「板块热力」页重试。`,
      ),
    );
    return;
  }
  const items = r.data?.items ?? [];
  if (items.length === 0) {
    mount(wrap, el('p', 'placeholder', '（无板块数据）'));
    return;
  }
  const grid = renderSectorHeatmap(items, 'mini');
  grid.addEventListener('click', () => {
    window.location.hash = '#sectors';
  });
  grid.style.cursor = 'pointer';
  mount(wrap, grid);
};

/* ---- 财经要闻（/api/news，点击跳原文） ---- */

const newsRow = (item) => {
  const title = el('a', 'news-title', item.title);
  if (typeof item.url === 'string' && item.url.length > 0) {
    title.setAttribute('href', item.url);
    title.setAttribute('target', '_blank');
    title.setAttribute('rel', 'noopener noreferrer');
  }
  return el('div', 'news-row', [
    el('span', 'news-dot'),
    el('div', 'news-main', [
      title,
      el('div', 'news-meta', `${item.source ?? '东方财富'} · ${fmtRelativeTime(item.publishedAt)}`),
    ]),
  ]);
};

const renderNews = async () => {
  const wrap = $('#dash-news-list');
  if (wrap === null) return;
  const r = await callApi('/api/news?limit=8');
  if (!r.ok) {
    mount(wrap, el('p', 'placeholder', `要闻加载失败（${r.error?.kind ?? 'internal'}）。`));
    return;
  }
  const items = r.data?.items ?? [];
  if (items.length === 0) {
    mount(wrap, el('p', 'placeholder', '（暂无所选分类要闻）'));
    return;
  }
  mount(wrap, el('div', 'news-list', items.map(newsRow)));
  const meta = $('#dash-news-meta');
  if (meta !== null && r.data?.asOf !== undefined) meta.textContent = `共 ${r.data.total} 条`;
};

/** 进入 dashboard 路由时调用一次；三区块并发加载、独立降级。 */
const renderDashboardMarketBlocks = async () => {
  await Promise.all([renderOverview(), renderMiniHeatmap(), renderNews()]);
};

export { firstProbeDay, fmtRelativeTime, overviewStats, prevDay, renderDashboardMarketBlocks };
