/* 看盘市场区块独立刷新，失败保留最后成功结果。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { openModal } from './modal.js';
import { renderSectorHeatmap, selectSectorExtremes } from './sector-heatmap.js';
import { $, el, fmtTime, mount } from './ui.js';

let marketEpoch = 0;
let marketPending = null;
let refreshNews = null;
const marketCurrent = (epoch) => epoch === marketEpoch && !$('#route-dashboard').hidden;
const invalidateDashboardMarket = () => {
  marketEpoch += 1;
  marketPending = null;
  newsRequestId += 1;
  refreshNews = null;
};

const overviewMeta = (snapshot) => {
  const states = { complete: '完整', partial: '部分可用', unavailable: '不可用' };
  return `交易日 ${snapshot.date} · 数据截至 ${fmtTime(snapshot.dataAsOf)} · 上涨/下跌 ${states[snapshot.breadth.status]} · 涨停 ${states[snapshot.limitUp.status]}`;
};

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
const fetchSentimentSnapshot = async (epoch) => {
  let day = firstProbeDay();
  for (let i = 0; i < 7; i += 1) {
    // 循环内逐日探测，必须串行（后一天依赖前一天结果）
    const r = await callApi('/api/tools/get_ashare_sentiment/call', {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({ input: { date: day, includeIndexes: false } }),
    });
    if (!marketCurrent(epoch)) return null;
    if (r.ok && r.data?.snapshot !== undefined) return r.data.snapshot;
    if (r.error?.kind !== 'invalid_input') return null;
    day = prevDay(day);
  }
  return null;
};

const renderOverview = async (epoch) => {
  const snapshot = await fetchSentimentSnapshot(epoch);
  if (!marketCurrent(epoch)) return;
  const meta = $('#dashboard-overview-meta');
  if (snapshot === null || snapshot === undefined) {
    meta.textContent = `刷新失败 · ${meta.dataset.lastSuccess ?? '尚无可用快照'}`;
    return;
  }
  meta.dataset.lastSuccess = overviewMeta(snapshot);
  meta.textContent = meta.dataset.lastSuccess;
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

const renderMiniHeatmap = async (epoch) => {
  const wrap = $('#dash-sector-heatmap');
  if (wrap === null) return;
  const r = await callApi('/api/market/sectors?sort=changePct&all=true', { timeoutMs: 15000 });
  if (!marketCurrent(epoch)) return;
  const meta = $('#dash-sector-meta');
  if (!r.ok) {
    meta.textContent = `刷新失败（${r.error?.kind ?? 'internal'}） · ${meta.dataset.lastSuccess ?? '尚无可用结果'}`;
    if (!wrap.querySelector('.sector-heatmap'))
      mount(wrap, el('p', 'placeholder', '板块暂不可用，可点击「刷新看盘」重试。'));
    return;
  }
  meta.dataset.lastSuccess = '板块行情已加载';
  meta.textContent = `${meta.dataset.lastSuccess} · 每 60 秒检查更新`;
  const items = selectSectorExtremes(r.data?.items ?? [], 15);
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

/* ---- 财经要闻（双源分页；滚动到底加载更多；点击弹出详情） ---- */

const NEWS_PAGE_SIZE = 8;
let newsRequestId = 0;

const shouldLoadNewsOnScroll = (container) =>
  container.scrollHeight - container.scrollTop - container.clientHeight < 48;

const showNewsDetail = (item) => {
  const time = new Date(item.publishedAt).toLocaleString('zh-CN', { hour12: false });
  const source = item.source ?? '未知来源';
  const body = el('article', 'news-detail', [
    el('div', 'news-detail-meta', `${source} · ${time}`),
    el('p', 'news-detail-summary', item.summary || item.title),
  ]);
  if (typeof item.url === 'string' && item.url.length > 0) {
    const link = el('a', 'btn btn-primary news-detail-link', '查看原文 ↗');
    link.setAttribute('href', item.url);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    body.append(link);
  }
  openModal(item.title, body);
};

const newsRow = (item) => {
  const title = el('button', 'news-title', item.title);
  title.type = 'button';
  title.addEventListener('click', () => showNewsDetail(item));
  const row = el('div', 'news-row', [
    el('span', 'news-dot'),
    el('div', 'news-main', [
      title,
      el('div', 'news-meta', `${item.source ?? '东方财富'} · ${fmtRelativeTime(item.publishedAt)}`),
    ]),
  ]);
  return row;
};

const renderNewsSource = async (source) => {
  const epoch = marketEpoch;
  const wrap = $('#dash-news-list');
  if (wrap === null) return;
  const requestId = ++newsRequestId;
  wrap.onscroll = null;
  let page = 1;
  let loading = false;
  let finished = false;
  let lastScrollLoadAt = 0;
  const list = el('div', 'news-list');
  const sentinel = el('button', 'news-load-sentinel', '加载更多');
  sentinel.type = 'button';
  let mounted = false;
  refreshNews = null;

  const loadPage = async () => {
    if (loading || finished) return;
    loading = true;
    sentinel.disabled = true;
    sentinel.textContent = '正在加载…';
    const r = await callApi(
      `/api/news?limit=${NEWS_PAGE_SIZE}&page=${page}&source=${encodeURIComponent(source)}`,
      { timeoutMs: 15000 },
    );
    if (requestId !== newsRequestId || !marketCurrent(epoch)) return;
    if (!r.ok) {
      const meta = $('#dash-news-meta');
      meta.textContent = `刷新失败（${source}） · ${meta.dataset.lastSuccess ?? '尚无可用要闻'} · 点击来源或刷新看盘重试`;
      if (!wrap.querySelector('.news-row'))
        mount(wrap, el('p', 'placeholder', '要闻暂不可用，请点击来源或刷新看盘重试。'));
      sentinel.textContent = `加载失败，点击重试（${r.error?.kind ?? 'internal'}）`;
      sentinel.classList.add('is-error');
      sentinel.disabled = false;
      loading = false;
      return;
    }
    if (!mounted) {
      mount(wrap, [list, sentinel]);
      mounted = true;
    }
    const meta = $('#dash-news-meta');
    sentinel.classList.remove('is-error');
    const items = r.data?.items ?? [];
    const knownIds = new Set(Array.from(list.children, (node) => node.dataset.newsId));
    for (const item of items) {
      if (knownIds.has(String(item.id))) continue;
      const row = newsRow(item);
      row.dataset.newsId = String(item.id);
      list.append(row);
    }
    page += 1;
    finished = items.length < NEWS_PAGE_SIZE;
    sentinel.textContent = finished ? '已加载全部快讯' : '加载更多';
    sentinel.disabled = finished;
    if (page === 2 && items.length === 0) sentinel.textContent = '（暂无快讯）';
    meta.dataset.lastSuccess = `已加载 ${list.children.length} 条`;
    meta.textContent = meta.dataset.lastSuccess;
    loading = false;
  };

  sentinel.addEventListener('click', () => {
    if (performance.now() - lastScrollLoadAt < 1_500) return;
    void loadPage();
  });
  await loadPage();
  if (requestId !== newsRequestId || !marketCurrent(epoch)) return;
  refreshNews = async () => {
    if (loading) return;
    if (!mounted) return loadPage();
    loading = true;
    const r = await callApi(
      `/api/news?limit=${NEWS_PAGE_SIZE}&page=1&source=${encodeURIComponent(source)}`,
      { timeoutMs: 15000 },
    );
    if (requestId !== newsRequestId || !marketCurrent(epoch)) return;
    loading = false;
    const meta = $('#dash-news-meta');
    if (!r.ok) {
      meta.textContent = `刷新失败 · ${meta.dataset.lastSuccess}`;
      return;
    }
    const known = new Set([...list.children].map((node) => node.dataset.newsId));
    const fresh = (r.data?.items ?? []).filter((item) => !known.has(String(item.id)));
    // offset 分页在新增头条后可能重叠，后续加载仍按 news id 去重。
    const previousHeight = wrap.scrollHeight;
    const previousScroll = wrap.scrollTop;
    list.prepend(
      ...fresh.map((item) => {
        const row = newsRow(item);
        row.dataset.newsId = String(item.id);
        return row;
      }),
    );
    if (previousScroll > 0) wrap.scrollTop = previousScroll + wrap.scrollHeight - previousHeight;
    meta.dataset.lastSuccess = `已加载 ${list.children.length} 条`;
    meta.textContent = meta.dataset.lastSuccess;
  };
  wrap.onscroll = () => {
    if (!shouldLoadNewsOnScroll(wrap)) return;
    lastScrollLoadAt = performance.now();
    void loadPage();
  };
};

const renderNews = async () => {
  const tabs = Array.from(document.querySelectorAll('[data-news-source]'));
  const activate = async (tab) => {
    for (const item of tabs) {
      const selected = item === tab;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', String(selected));
    }
    await renderNewsSource(tab.dataset.newsSource);
  };
  for (const tab of tabs) tab.onclick = () => void activate(tab);
  const active = tabs.find((tab) => tab.classList.contains('active')) ?? tabs[0];
  if (active !== undefined) await activate(active);
};

const renderDashboardMarketBlocks = () => {
  if (marketPending !== null) return marketPending;
  const epoch = marketEpoch;
  const pending = Promise.all([
    renderOverview(epoch),
    renderMiniHeatmap(epoch),
    refreshNews === null ? renderNews() : refreshNews(),
  ]).finally(() => {
    if (marketPending === pending) marketPending = null;
  });
  marketPending = pending;
  return pending;
};

export {
  firstProbeDay,
  fmtRelativeTime,
  invalidateDashboardMarket,
  overviewMeta,
  overviewStats,
  prevDay,
  renderDashboardMarketBlocks,
  shouldLoadNewsOnScroll,
};
