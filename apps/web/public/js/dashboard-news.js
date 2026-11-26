/* apps/web/public/js/dashboard-news.js —— 首页「财经要闻」：双源分页，滚动到底加载更多，点击弹出详情。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { openModal } from './modal.js';
import { $, el, mount } from './ui.js';

const NEWS_PAGE_SIZE = 8;

let newsEpoch = 0;
let newsPending = null;
let newsRequestId = 0;
let refreshNews = null;

const invalidateDashboardNews = () => {
  newsEpoch += 1;
  newsPending = null;
  newsRequestId += 1;
  refreshNews = null;
};

const newsCurrent = (epoch) => epoch === newsEpoch && $('#route-dashboard').hidden === false;

/**
 * 相对时间（纯函数，dashboard-news.test.js 单测）：
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
  return el('div', 'news-row', [
    el('span', 'news-dot'),
    el('div', 'news-main', [
      title,
      el('div', 'news-meta', `${item.source ?? '东方财富'} · ${fmtRelativeTime(item.publishedAt)}`),
    ]),
  ]);
};

const renderNewsSource = async (source) => {
  const epoch = newsEpoch;
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
    if (requestId !== newsRequestId || !newsCurrent(epoch)) return;
    if (!r.ok) {
      const meta = $('#dash-news-meta');
      meta.textContent = `刷新失败（${source}） · ${meta.dataset.lastSuccess ?? '尚无可用要闻'} · 点击来源或刷新页面重试`;
      if (!wrap.querySelector('.news-row'))
        mount(wrap, el('p', 'placeholder', '要闻暂不可用，请点击来源重试。'));
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
  if (requestId !== newsRequestId || !newsCurrent(epoch)) return;
  refreshNews = async () => {
    if (loading) return;
    if (!mounted) return loadPage();
    loading = true;
    const r = await callApi(
      `/api/news?limit=${NEWS_PAGE_SIZE}&page=1&source=${encodeURIComponent(source)}`,
      { timeoutMs: 15000 },
    );
    if (requestId !== newsRequestId || !newsCurrent(epoch)) return;
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

const renderDashboardNews = () => {
  if (newsPending !== null) return newsPending;
  const pending = (refreshNews === null ? renderNews() : refreshNews()).finally(() => {
    if (newsPending === pending) newsPending = null;
  });
  newsPending = pending;
  return pending;
};

export { fmtRelativeTime, invalidateDashboardNews, renderDashboardNews, shouldLoadNewsOnScroll };
