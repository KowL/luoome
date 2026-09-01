/* apps/web/public/js/market-quote.js —— 行情页报价卡与指标渲染（设计 §11.2 / §11.3）。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import {
  changeClass,
  fetchedAtLabel,
  formatAmount,
  formatVolume,
  sessionLabel,
  sourceSummary,
  stockCodeLabel,
  xueqiuStockUrl,
} from './market-shared.js';
import { $, el, fmtNum, fmtPct, fmtSigned, mount } from './ui.js';

const setText = (id, text, className) => {
  const node = $(id);
  if (node === null) return;
  node.textContent = text;
  if (className !== undefined) node.className = className;
};

const renderQuoteHeader = (data) => {
  const { stock, quote, dataStatus } = data;
  setText('#market-quote-name', stock.name);
  setText('#market-quote-code', stockCodeLabel(stock));
  const codeLink = $('#market-quote-code');
  if (codeLink !== null) {
    const href = xueqiuStockUrl(stock.id);
    if (href === null) {
      codeLink.removeAttribute('href');
      codeLink.removeAttribute('aria-label');
    } else {
      codeLink.setAttribute('href', href);
      codeLink.setAttribute('aria-label', `在雪球查看 ${stock.name}（${stock.id}）`);
    }
  }
  setText(
    '#market-quote-price',
    fmtNum(quote.quote.close),
    `market-quote-price ${changeClass(quote.change)}`,
  );
  setText('#market-quote-change', fmtSigned(quote.change), changeClass(quote.change));
  setText('#market-quote-change-pct', fmtPct(quote.changePct), changeClass(quote.change));
  setText('#market-quote-open', fmtNum(quote.quote.open), 'num');
  setText('#market-quote-high', fmtNum(quote.quote.high), 'num');
  setText('#market-quote-low', fmtNum(quote.quote.low), 'num');
  setText(
    '#market-quote-prev',
    quote.previousClose === null ? '--' : fmtNum(quote.previousClose),
    'num',
  );
  setText('#market-quote-volume', formatVolume(quote.quote.volume), 'num');
  setText('#market-quote-amount', formatAmount(quote.quote.amount), 'num');
  setText(
    '#market-quote-turnover',
    typeof quote.quote.turnoverRatePct === 'number'
      ? `${quote.quote.turnoverRatePct.toFixed(2)}%`
      : '--',
    'num',
  );
  setText('#market-quote-amplitude', fmtPct(quote.amplitude), 'num');
  setText('#market-quote-total-market-cap', formatAmount(quote.quote.totalMarketCap), 'num');
  setText('#market-quote-float-market-cap', formatAmount(quote.quote.floatMarketCap), 'num');
  setText('#market-quote-pe-ttm', fmtNum(quote.quote.peTtm), 'num');
  setText('#market-quote-pe-dynamic', fmtNum(quote.quote.peDynamic), 'num');
  setText('#market-quote-pe-static', fmtNum(quote.quote.peStatic), 'num');
  setText('#market-quote-ps-ttm', fmtNum(quote.quote.psTtm), 'num');
  setText('#market-quote-pb', fmtNum(quote.quote.pb), 'num');
  setText('#market-quote-total-shares', formatVolume(quote.quote.totalShares), 'num');
  setText('#market-quote-float-shares', formatVolume(quote.quote.floatShares), 'num');
  setText('#market-quote-fetched', fetchedAtLabel(dataStatus.quoteFetchedAt));
  setText('#market-quote-source', sourceSummary(dataStatus.sources, quote.quote.source));

  const badges = $('#market-quote-badges');
  if (badges !== null) {
    const items = [el('span', 'badge badge-session', sessionLabel(dataStatus.marketSession))];
    if (dataStatus.retrieval === 'local-fallback') {
      items.push(el('span', 'badge badge-amber', '旧快照'));
    }
    if (dataStatus.warnings.includes('provider-fallback')) {
      items.push(el('span', 'badge badge-amber', '含备用行情源'));
    }
    if (dataStatus.warnings.includes('bars-truncated')) {
      items.push(el('span', 'badge badge-amber', '历史数据截断'));
    }
    mount(badges, items);
  }
};

/** 报价卡常驻后，无股票 / 加载失败时清掉上一只股票残留的数据；占位 id 从 DOM 派生。 */
const resetQuoteHeader = () => {
  document
    .querySelectorAll('#market-quote-card [id^="market-quote-"]:not(#market-quote-badges)')
    .forEach((node) => {
      node.textContent = '--';
    });
  setText('#market-quote-price', '--', 'market-quote-price');
  const codeLink = $('#market-quote-code');
  codeLink?.removeAttribute('href');
  codeLink?.removeAttribute('aria-label');
  const badges = $('#market-quote-badges');
  if (badges !== null) mount(badges, null);
};

const INDICATOR_ROWS = [
  { label: 'RSI14', value: (i) => fmtNum(i.rsi14) },
  { label: 'MACD DIF', value: (i) => fmtNum(i.macdDif) },
  { label: 'MACD DEA', value: (i) => fmtNum(i.macdDea) },
  { label: 'MACD HIST', value: (i) => fmtNum(i.macdHist) },
  { label: 'BOLL 上轨', value: (i) => fmtNum(i.bollUpper20) },
  { label: 'BOLL 中轨', value: (i) => fmtNum(i.bollMiddle20) },
  { label: 'BOLL 下轨', value: (i) => fmtNum(i.bollLower20) },
  { label: '20 日最高', value: (i) => fmtNum(i.high20) },
  { label: '20 日最低', value: (i) => fmtNum(i.low20) },
  { label: '成交量比', value: (i) => fmtNum(i.volRatio5_20) },
];

const renderIndicators = (data) => {
  const wrap = $('#market-indicators');
  if (wrap === null) return;
  mount(
    wrap,
    INDICATOR_ROWS.map((row) =>
      el('div', 'market-indicator', [
        el('div', 'label', row.label),
        el('div', 'value', row.value(data.indicators ?? {})),
      ]),
    ),
  );
  setText(
    '#market-indicators-meta',
    data.indicatorsAsOf === null ? '样本不足' : `截至 ${data.indicatorsAsOf}`,
  );
};

const renderLinks = (data) => {
  const wrap = $('#market-links');
  if (wrap === null) return;
  const id = encodeURIComponent(data.stock.id);
  const links = [
    { href: `#research?stockId=${id}`, label: '查看研究' },
    { href: `#advice?stockId=${id}`, label: '查看 Advice' },
    { href: `#holdings?stockId=${id}`, label: '持仓定位' },
  ];
  mount(
    wrap,
    links.map((l) => {
      const a = el('a', 'btn btn-outline btn-sm', l.label);
      a.setAttribute('href', l.href);
      return a;
    }),
  );
};

export { renderIndicators, renderLinks, renderQuoteHeader, resetQuoteHeader, setText };
