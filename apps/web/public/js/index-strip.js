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

/**
 * 渲染固定指数卡片（看盘页 4 卡 / 指数页 6 卡共用）。
 * 与 strip 不同：数据缺失 / unsupported 时卡片仍渲染，值降级为 '--'（用户要求看到卡片结构）。
 * onSelect 非空时卡片可点击（指数页选中切换分时图），selectedCode 命中的卡加 selected class。
 */
const renderIndexCards = (containerId, defs, indicesData, options = {}) => {
  const wrap = $(`#${containerId}`);
  if (wrap === null) return;
  const list = Array.isArray(indicesData?.indices) ? indicesData.indices : [];
  const byCode = new Map(list.map((idx) => [String(idx.code), idx]));
  mount(
    wrap,
    defs.map((def) => {
      const idx = byCode.get(def.code);
      const hasData = idx !== undefined;
      const cls = !hasData ? '' : idx.change > 0 ? 'pos' : idx.change < 0 ? 'neg' : '';
      const card = el('div', `index-card ${cls}`, [
        el('div', 'index-card-name', def.name),
        el('div', 'index-card-close mono', hasData ? fmtNum(idx.close) : '--'),
        el(
          'div',
          'index-card-change mono',
          hasData ? `${fmtSigned(idx.change)}（${fmtSigned(idx.changePct)}%）` : '--',
        ),
      ]);
      if (options.onSelect !== undefined) {
        card.classList.add('clickable');
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        card.setAttribute('aria-label', `查看${def.name}分时走势`);
        if (options.selectedCode === def.code) card.classList.add('selected');
        const select = () => options.onSelect(def.code);
        card.addEventListener('click', select);
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select();
          }
        });
      }
      return card;
    }),
  );
};

export { renderIndexCards, renderIndexStrip };
