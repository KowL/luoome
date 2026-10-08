/* apps/web/public/js/market-facts.js —— 行情页关联事实渲染：图表标记与涨停天梯（设计 §11.3）。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { setText } from './market-quote.js';
import { factKindLabel, signalDirectionLabel } from './market-shared.js';
import { $, el, mount } from './ui.js';

const markerLabel = (marker) =>
  `${marker.date} · ${factKindLabel(marker.factKind)} · ${marker.title}`;

/* ---- 连续触发合并：同一规则同一方向的相邻交易日信号折叠为一条 run chip ---- */

/** 连续 run 的最短天数：低于此仍按日分组展示。 */
const RUN_MIN_DAYS = 3;
/** 相邻信号日期间隔上限（自然日）：覆盖周末与短假；长假断开，宁断不造假。 */
const RUN_MAX_GAP_DAYS = 4;

const DAY_MS = 86_400_000;
const dayGap = (a, b) =>
  Math.round((new Date(`${b}T00:00:00.000Z`) - new Date(`${a}T00:00:00.000Z`)) / DAY_MS);

/**
 * strategy-signal 中同一 ruleId + 方向的相邻交易日序列折叠为 run；
 * 缺 ruleId 的旧数据与其它类型事实原样留在 rest，不参与合并。
 * 返回 { runs, rest }；run: { direction, ruleId, start, end, days, items }。
 */
const collapseSignalRuns = (markers) => {
  const runs = [];
  const rest = [];
  const byKey = new Map();
  for (const marker of markers) {
    if (marker.factKind !== 'strategy-signal' || marker.ruleId === undefined) {
      rest.push(marker);
      continue;
    }
    const key = `${marker.direction ?? ''}|${marker.ruleId}`;
    const group = byKey.get(key);
    if (group === undefined) byKey.set(key, [marker]);
    else group.push(marker);
  }
  for (const group of byKey.values()) {
    const sorted = [...group].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let current = [sorted[0]];
    const flush = () => {
      const days = new Set(current.map((item) => item.date)).size;
      if (days >= RUN_MIN_DAYS) {
        runs.push({
          direction: current[0].direction,
          ruleId: current[0].ruleId,
          start: current[0].date,
          end: current[current.length - 1].date,
          days,
          items: current,
        });
      } else {
        rest.push(...current);
      }
    };
    for (let i = 1; i < sorted.length; i += 1) {
      if (dayGap(sorted[i - 1].date, sorted[i].date) <= RUN_MAX_GAP_DAYS) {
        current.push(sorted[i]);
      } else {
        flush();
        current = [sorted[i]];
      }
    }
    flush();
  }
  runs.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { runs, rest };
};

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

const markerGroupChip = (group, onFocus) => {
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
  const titles = group.items.map((item) => item.title).join('\n');
  link.title = `单击在 K 线定位；${group.items.length > 1 ? `组内事实：\n${titles}` : '跳转请用新标签打开'}`;
  if (onFocus !== undefined) {
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onFocus(first.date);
      link.classList.remove('market-marker-flash');
      // 强制重启动画
      void link.offsetWidth;
      link.classList.add('market-marker-flash');
    });
  }
  return link;
};

const runChip = (run, onFocus) => {
  const direction = signalDirectionLabel(run.direction);
  const label = `${factKindLabel('strategy-signal')}${direction === null ? '' : ` · ${direction}`} · ${run.ruleId} · ${run.start} ~ ${run.end} · 连续${run.days}日`;
  const link = el(
    'a',
    `market-marker market-marker-fact market-marker-run${direction === null ? '' : ` market-marker-${run.direction}`}`,
    label,
  );
  link.setAttribute('href', run.items[0].href);
  link.dataset.factId = run.items[0].factId;
  link.title = `单击在 K 线定位首日；组内事实：\n${run.items.map((item) => `${item.date} · ${item.title}`).join('\n')}`;
  if (onFocus !== undefined) {
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onFocus(run.start);
      link.classList.remove('market-marker-flash');
      void link.offsetWidth;
      link.classList.add('market-marker-flash');
    });
  }
  return link;
};

const renderMarkers = (data, groupKey, onFocus) => {
  const wrap = $('#market-markers');
  if (wrap === null) return;
  const markers = Array.isArray(data.markers) ? data.markers : [];
  if (markers.length === 0) {
    markersExpandedKey = null;
    mount(wrap, el('span', 'muted', '当前周期暂无关联事实'));
    return;
  }
  const { runs, rest } = collapseSignalRuns(markers);
  const groups = groupMarkers(rest);
  const units = [
    ...runs.map((run) => ({ kind: 'run', run })),
    ...groups.map((group) => ({ kind: 'group', group })),
  ];
  const expandable = units.length > MARKER_CHIP_LIMIT;
  const expanded = expandable && groupKey !== undefined && markersExpandedKey === groupKey;
  const visible = expanded ? units : units.slice(0, MARKER_CHIP_LIMIT);
  const toggle = expandable
    ? el(
        'button',
        'market-marker-more',
        expanded ? '收起' : `展开其余 ${units.length - MARKER_CHIP_LIMIT} 组`,
      )
    : null;
  if (toggle !== null) {
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      markersExpandedKey = expanded ? null : (groupKey ?? null);
      renderMarkers(data, groupKey, onFocus);
    });
  }
  mount(wrap, [
    el('span', 'muted', '图表事实：'),
    ...visible.map((unit) =>
      unit.kind === 'run' ? runChip(unit.run, onFocus) : markerGroupChip(unit.group, onFocus),
    ),
    toggle,
  ]);
};

export { collapseSignalRuns, groupMarkers, markerLabel, renderLimitUpFacts, renderMarkers };
