/* apps/web/public/js/sector-heatmap.js —— 板块热力图共用渲染。
 *
 * sectors 页（全量热力）与看盘页（迷你热力）共用；
 * 红涨绿跌沿用全局 --pos / --neg 口径，色深随 |涨跌幅| 加深。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { el } from './ui.js';

const formatPct = (n) => `${n > 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;

/** 成交额（元）→ 亿，保留 1 位小数。 */
const formatAmount = (n) => `${(n / 100_000_000).toFixed(1)}亿`;

/** 按涨幅降序排列：上涨 → 平盘 → 下跌。 */
const sortSectorHeatmapItems = (items) =>
  [...items].sort((a, b) => {
    const diff = b.changePct - a.changePct;
    return diff !== 0 ? diff : a.name.localeCompare(b.name, 'zh-CN');
  });

/** 取涨幅最大与跌幅最大的各 limit 个板块，热力图固定展示双侧极值。 */
const selectSectorExtremes = (items, limit = 15) => {
  const source = Array.isArray(items) ? items : [];
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const up = source.filter((item) => item.changePct > 0).sort((a, b) => b.changePct - a.changePct);
  const down = source
    .filter((item) => item.changePct < 0)
    .sort((a, b) => a.changePct - b.changePct);
  return sortSectorHeatmapItems([...up.slice(0, limit), ...down.slice(0, limit)]);
};

/**
 * 热力格配色：|pct| 越大 alpha 越深（0.12 → 0.9 区间），alpha > 0.45 时用白字。
 * 红 rgb(224,72,79)（--pos）涨，绿 rgb(15,157,88)（--neg）跌。
 */
const sectorTileStyle = (changePct) => {
  const abs = Math.abs(changePct);
  const alpha = Math.min(0.12 + (abs / 0.05) * 0.78, 0.9);
  const rgb = changePct >= 0 ? '224, 72, 79' : '15, 157, 88';
  return {
    background: `rgba(${rgb}, ${alpha.toFixed(2)})`,
    color: alpha > 0.45 ? '#fff' : 'inherit',
  };
};

const renderTile = (item) => {
  const style = sectorTileStyle(item.changePct);
  const tile = el('div', 'sector-tile', [
    el('div', 'sector-tile-name', item.name),
    el('div', 'sector-tile-pct', formatPct(item.changePct)),
    el('div', 'sector-tile-lead', item.leadingStockName ?? '--'),
  ]);
  tile.style.background = style.background;
  tile.style.color = style.color;
  tile.title =
    `${item.name} ${formatPct(item.changePct)} 成交额 ${formatAmount(item.amount)}` +
    (item.leadingStockName !== undefined
      ? ` 领涨 ${item.leadingStockName} ${formatPct(item.leadingStockChangePct ?? 0)}`
      : '');
  return tile;
};

/**
 * 渲染热力图 grid（按涨幅降序平铺）。
 * @param {Array} items fetch_sector_quotes 的 items
 * @param {string} [extraClass] 附加 class（如 'mini' 迷你版）
 */
const renderSectorHeatmap = (items, extraClass = '') => {
  const sorted = sortSectorHeatmapItems(items);
  return el(
    'div',
    `sector-heatmap${extraClass.length > 0 ? ` ${extraClass}` : ''}`,
    sorted.map(renderTile),
  );
};

export { renderSectorHeatmap, sectorTileStyle, selectSectorExtremes, sortSectorHeatmapItems };
