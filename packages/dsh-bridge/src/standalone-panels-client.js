import { createElement as h } from 'react';

import { OverviewPanel } from './panels/overview.js';
import { ReviewPanel } from './panels/review.js';
import { StrategiesPanel } from './panels/strategies.js';

const icon = (paths) =>
  h(
    'svg',
    {
      viewBox: '0 0 16 16',
      width: '14',
      height: '14',
      fill: 'none',
      'aria-hidden': true,
      style: { display: 'block' },
    },
    paths.map((path, index) =>
      h('path', {
        key: index,
        d: path,
        stroke: 'currentColor',
        'stroke-width': '1.3',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    ),
  );

const PulseIcon = () => icon(['M1.5 8.5h2.4L5.6 3l2.6 10 2-6.5 1.2 2h3.1']);
const LayersIcon = () =>
  icon(['M8 1.8 14 5 8 8.2 2 5l6-3.2Z', 'M2 8.3 8 11.5l6-3.2', 'M2 11.4 8 14.6l6-3.2']);
const RewindIcon = () =>
  icon(['M2.2 8a5.8 5.8 0 1 0 1.7-4.1', 'M2 2.4v3.2h3.2', 'M8 5.4 5.6 8 8 10.6']);

const panels = [
  ['overview', '看盘', '市场温度 · 持仓 · 今日触发', PulseIcon, OverviewPanel],
  ['strategies', '策略看板', '版本 · 运行 · 发布 · 观察', LayersIcon, StrategiesPanel],
  ['review', '复盘', '建议表现 · 校准 · 待补观察', RewindIcon, ReviewPanel],
];

export const inject = ['slots'];

export function apply(ctx) {
  for (const [panel, title, subtitle, Icon, View] of panels) {
    const id = `luoome-${panel}`;
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        { name: 'main', key: id, inject: () => ({ panel, title, subtitle }) },
        View,
      ),
    );
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register({ name: 'sidebar.panellist', id, order: 20, label: () => title }, () =>
        h(Icon, null),
      ),
    );
  }
}
