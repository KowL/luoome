/* apps/web/public/js/index-strip.js —— 大盘指数条渲染。
 *
 * 仪表盘 #dashboard-indices 与行情页 #market-indices 共用；
 * unsupported 或空数组时整条隐藏；红涨绿跌沿用 pos/neg。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { $, el, fmtNum, fmtSigned, mount } from './ui.js';

const fmtTime = (d) => {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
};

/** 渲染指数条到 containerId 容器；数据来自 /api/dashboard 或 /api/market/indices 的 indices 字段。 */
const renderIndexStrip = (containerId, indicesData, asOf) => {
  const strip = $(`#${containerId}`);
  if (strip === null) return;
  const list = Array.isArray(indicesData?.indices) ? indicesData.indices : [];
  if (indicesData?.unsupported === true || list.length === 0) {
    strip.hidden = true;
    strip.replaceChildren();
    return;
  }
  strip.hidden = false;
  const chips = list.map((idx) => {
    const cls = idx.change > 0 ? 'pos' : idx.change < 0 ? 'neg' : 'flat';
    return el('span', `index-chip ${cls}`, [
      el('span', 'index-name', idx.name),
      el('span', 'index-close mono', fmtNum(idx.close)),
      el('span', 'index-change mono', `${fmtSigned(idx.change)}（${fmtSigned(idx.changePct)}%）`),
    ]);
  });
  mount(strip, [
    ...chips,
    ...(asOf === null || asOf === undefined
      ? []
      : [el('span', 'index-asof', `截至 ${fmtTime(asOf)}`)]),
  ]);
};

export { renderIndexStrip };
