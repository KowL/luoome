/* apps/web/public/js/market-facts.js —— 行情页关联事实渲染：图表标记与涨停天梯（设计 §11.3）。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { setText } from './market-quote.js';
import { $, el, mount } from './ui.js';

const markerLabel = (marker) => {
  const kind =
    marker.factKind === 'trade'
      ? '交易'
      : marker.factKind === 'advice'
        ? 'Advice'
        : marker.factKind === 'watch-trigger'
          ? '触发'
          : marker.factKind === 'strategy-signal'
            ? '信号'
            : marker.factKind === 'report'
              ? '报告'
              : marker.factKind === 'limit-up'
                ? '涨停'
                : '研究';
  return `${marker.date} · ${kind} · ${marker.title}`;
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

const renderMarkers = (data) => {
  const wrap = $('#market-markers');
  if (wrap === null) return;
  const markers = Array.isArray(data.markers) ? data.markers : [];
  mount(
    wrap,
    markers.length === 0
      ? el('span', 'muted', '当前周期暂无关联事实')
      : [
          el('span', 'muted', '图表事实：'),
          ...markers.map((marker) => {
            const link = el('a', `market-marker market-marker-${marker.tone}`, markerLabel(marker));
            link.setAttribute('href', marker.href);
            link.dataset.factId = marker.factId;
            return link;
          }),
        ],
  );
};

export { markerLabel, renderLimitUpFacts, renderMarkers };
