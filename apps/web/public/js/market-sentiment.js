/* apps/web/public/js/market-sentiment.js —— 行情页空态 A 股情绪面板。
 *
 * 只在未选 stockId 的空态（#market-empty 可见）渲染；数据源
 * POST /api/tools/get_ashare_sentiment/call（includeIndexes: false，指数由指数条覆盖）。
 * 各维度 status 独立降级；整体失败只显示轻量错误，不影响搜索框。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { buildMarketHash, formatAmount } from './market-shared.js';
import { $, el, mount } from './ui.js';

/** 今日（Asia/Shanghai）YYYY-MM-DD。 */
const shanghaiToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

const fmtRate = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '--';

const dimUnavailable = (dim) => el('p', 'muted', dim.warnings?.[0] ?? '该维度暂不可用');

const breadthSection = (breadth) => {
  if (breadth?.value === undefined || breadth.value === null) return dimUnavailable(breadth ?? {});
  const { advancing, declining, unchanged, total } = breadth.value;
  return el('div', 'sentiment-row', [
    el('span', 'sentiment-label', '市场宽度'),
    el('span', 'text-pos', `涨 ${advancing}`),
    el('span', 'text-neg', `跌 ${declining}`),
    el('span', 'muted', `平 ${unchanged}`),
    el('span', 'muted', `共 ${total} 家`),
  ]);
};

const limitUpSection = (limitUp) => {
  if (limitUp?.value === undefined || limitUp.value === null) return dimUnavailable(limitUp ?? {});
  const v = limitUp.value;
  const distribution = Object.entries(v.boardDistribution ?? {})
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([level, count]) => `${level}板×${count}`)
    .join(' · ');
  const children = [
    el('div', 'sentiment-row', [
      el('span', 'sentiment-label', '涨跌停'),
      el('span', null, `封板 ${v.sealedCount}`),
      el('span', null, `炸板 ${v.brokenCount}`),
      el('span', null, `炸板率 ${fmtRate(v.brokenRate)}`),
      el('span', null, `最高 ${v.maxLadderLevel} 板`),
      ...(v.totalSealAmount !== null && v.totalSealAmount !== undefined
        ? [el('span', 'muted', `封单 ${formatAmount(v.totalSealAmount)}`)]
        : []),
    ]),
  ];
  if (distribution.length > 0) children.push(el('p', 'muted', `板数分布：${distribution}`));
  if (Array.isArray(v.leaders) && v.leaders.length > 0) {
    children.push(
      el('div', 'sentiment-leaders', [
        el('span', 'sentiment-label', '连板龙头'),
        ...v.leaders.map((leader) => {
          const a = el('a', 'stock-link', `${leader.name}（${leader.ladderLevel}板）`);
          a.setAttribute('href', `#${buildMarketHash(leader.stockId, '3m')}`);
          return a;
        }),
      ]),
    );
  }
  return el('div', null, children);
};

const themesSection = (themes) => {
  if (themes?.value === undefined || themes.value === null) return dimUnavailable(themes ?? {});
  const chips = (list, label) =>
    list.length === 0
      ? null
      : el('div', 'sentiment-row', [
          el('span', 'sentiment-label', label),
          ...list.map((item) => el('span', 'badge', `${item.name}×${item.count}`)),
        ]);
  return el('div', null, [
    chips(themes.value.industries ?? [], '行业热点'),
    chips(themes.value.concepts ?? [], '概念热点'),
  ]);
};

/** 拉取并渲染 A 股情绪到 #market-sentiment；空态不可见（已选股）时静默放弃。 */
const renderMarketSentiment = async () => {
  const container = $('#market-sentiment');
  if (container === null) return;
  const r = await callApi('/api/tools/get_ashare_sentiment/call', {
    method: 'POST',
    body: JSON.stringify({ input: { date: shanghaiToday(), includeIndexes: false } }),
  });
  // 等待期间用户已选股 / 离开空态：不覆盖当前画面
  if ($('#market-empty')?.hidden !== false) return;
  if (!r.ok || r.data?.snapshot === undefined) {
    mount(
      container,
      el('p', 'placeholder', `市场情绪数据加载失败（${r.error?.kind ?? 'internal'}）。`),
    );
    return;
  }
  const snapshot = r.data.snapshot;
  mount(
    container,
    el('div', 'sentiment-panel', [
      el('h3', 'sentiment-title', `A 股情绪（${snapshot.date}）`),
      breadthSection(snapshot.breadth),
      limitUpSection(snapshot.limitUp),
      themesSection(snapshot.themes),
    ]),
  );
};

export { renderMarketSentiment };
