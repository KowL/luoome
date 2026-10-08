/* apps/web/public/js/market-facts.js —— 行情页关联事实渲染：图表标记与涨停天梯（设计 §11.3）。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { setText } from './market-quote.js';
import { factKindLabel, signalDirectionLabel } from './market-shared.js';
import { $, el, mount } from './ui.js';

const markerLabel = (marker) =>
  `${marker.date} · ${factKindLabel(marker.factKind)} · ${marker.title}`;

const renderLimitUpFacts = (data) => {
  const wrap = $('#market-limit-up');
  if (wrap === null) return;
  const facts = data.limitUp;
  if (facts === undefined || facts.status === 'unavailable') {
    mount(wrap, el('span', 'muted', '历史天梯不可用；未将不可用伪装成空结果。'));
    setText('#market-limit-up-status', '不可用');
    return;
  }
  const coveredDays = Math.max(0, 30 - (facts.missingDates?.length ?? 0));
  const coverageLabel = facts.status === 'partial' ? `部分覆盖 ${coveredDays}/30 日` : '完整覆盖';
  setText(
    '#market-limit-up-status',
    facts.dataAsOf === null
      ? `${coverageLabel} · 时间未知`
      : `${coverageLabel} · ${new Date(facts.dataAsOf).toLocaleDateString('zh-CN')}`,
  );
  mount(wrap, [
    facts.status === 'partial'
      ? el('p', 'muted', '仅展示已保存的 PIT 快照；缺失日期未用当前接口回填。')
      : null,
    facts.recent.length === 0
      ? el('span', 'muted', '可获得范围内暂无涨停记录')
      : el(
          'div',
          'market-limit-up-list',
          facts.recent.map((item) =>
            el('div', 'market-limit-up-row', [
              el('span', 'mono', item.date),
              el('strong', null, `${item.ladderLevel} 连板`),
              el('span', 'muted', item.reason === '--' ? '原因暂缺' : item.reason),
            ]),
          ),
        ),
  ]);
};

/** 图表事实 chip 的默认展示组数：超出后折叠为「展开其余 N 组」。 */
const MARKER_CHIP_LIMIT = 10;

/** 当前展开状态锚定的股票（换股 / 空态自动回到折叠）。 */
let markersExpandedKey = null;

/** 同日同类同方向事实合并为一组，组顺序保持首条出现顺序。 */
const groupMarkers = (markers) => {
  const groups = [];
  const byKey = new Map();
  for (const marker of markers) {
    const key = `${marker.date}|${marker.factKind}|${marker.direction ?? ''}`;
    const group = byKey.get(key);
    if (group === undefined) {
      const created = {
        date: marker.date,
        factKind: marker.factKind,
        direction: marker.direction,
        items: [marker],
      };
      byKey.set(key, created);
      groups.push(created);
    } else {
      group.items.push(marker);
    }
  }
  return groups;
};

const markerGroupChip = (group) => {
  const first = group.items[0];
  const direction = signalDirectionLabel(group.direction);
  const label =
    group.items.length === 1
      ? markerLabel(first)
      : `${group.date} · ${factKindLabel(group.factKind)}×${group.items.length}${direction === null ? '' : ` · ${direction}`}`;
  const link = el(
    'a',
    `market-marker market-marker-${first.tone}${direction === null ? '' : ` market-marker-${group.direction}`}`,
    label,
  );
  link.setAttribute('href', first.href);
  link.dataset.factId = first.factId;
  if (group.items.length > 1) link.title = group.items.map((item) => item.title).join('\n');
  return link;
};

const renderMarkers = (data, groupKey) => {
  const wrap = $('#market-markers');
  if (wrap === null) return;
  const markers = Array.isArray(data.markers) ? data.markers : [];
  if (markers.length === 0) {
    markersExpandedKey = null;
    mount(wrap, el('span', 'muted', '当前周期暂无关联事实'));
    return;
  }
  const groups = groupMarkers(markers);
  const expandable = groups.length > MARKER_CHIP_LIMIT;
  const expanded = expandable && groupKey !== undefined && markersExpandedKey === groupKey;
  const visible = expanded ? groups : groups.slice(0, MARKER_CHIP_LIMIT);
  const toggle = expandable
    ? el(
        'button',
        'market-marker-more',
        expanded ? '收起' : `展开其余 ${groups.length - MARKER_CHIP_LIMIT} 组`,
      )
    : null;
  if (toggle !== null) {
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      markersExpandedKey = expanded ? null : (groupKey ?? null);
      renderMarkers(data, groupKey);
    });
  }
  mount(wrap, [el('span', 'muted', '图表事实：'), ...visible.map(markerGroupChip), toggle]);
};

export { groupMarkers, markerLabel, renderLimitUpFacts, renderMarkers };
