/* apps/web/public/js/index-strip.js —— 大盘指数卡片渲染。
 *
 * 看盘页 4 卡 / 指数页 6 卡共用；数据缺失或 unsupported 时卡片仍渲染，值降级为 '--'。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { $, el, fmtDateTime, fmtNum, fmtSigned, mount } from './ui.js';

/**
 * 渲染固定指数卡片（看盘页 4 卡 / 指数页 6 卡共用）。
 * 数据缺失 / unsupported 时卡片仍渲染，值降级为 '--'（用户要求看到卡片结构）。
 * onSelect 非空时卡片可点击（指数页选中切换分时图），selectedCode 命中的卡加 selected class。
 * showStaleTime：看盘页开启，仅当快照为旧快照 / 缺数据时才在卡片上补时间说明。
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
      // 4 张卡共用同一快照时刻，正常行情不再逐卡重复；只有旧快照 / 缺数据才提示。
      if (options.showStaleTime) {
        const stale = indicesData?.stale === true;
        if (!hasData || stale)
          card.append(
            el('small', 'muted', hasData ? `旧快照 · ${fmtDateTime(idx.ts)}` : '行情不可用'),
          );
      }
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

export { renderIndexCards };
