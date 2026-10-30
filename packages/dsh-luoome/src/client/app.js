// luoome 业务应用外壳：侧栏只有 LUOOME 一个入口，主区用顶部标签切换五个业务视图。
//
// 视图各自负责取数与展示，标签只做视图切换：未激活的视图不挂载，因此不会发起
// 状态请求，看盘页的定时刷新也只在该视图激活时运行。
import { createElement as h, useCallback, useState } from 'react';

import { OverviewPanel } from './overview.js';
import { PositionsPanel } from './positions.js';
import { cx, Panel } from './primitives.js';
import { ReviewPanel } from './review.js';
import { StrategiesPanel } from './strategies.js';
import { WatchlistsPanel } from './watchlists.js';

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
const PortfolioIcon = () => icon(['M2 5h12v8H2z', 'M5.5 5V2.5h5V5', 'M2 8.5h12', 'M7 8.5v2h2v-2']);
const WatchlistIcon = () => icon(['M4 2h8v12l-4-2.5L4 14V2Z']);
/** 侧栏入口图标：五个业务视图合成一个入口。 */
export const AppIcon = () =>
  icon([
    'M2.5 2.5h4.2v4.2H2.5z',
    'M9.3 2.5h4.2v4.2H9.3z',
    'M2.5 9.3h4.2v4.2H2.5z',
    'M9.3 9.3h4.2v4.2H9.3z',
  ]);

export const VIEWS = [
  {
    id: 'overview',
    label: '看盘',
    hint: '市场温度 · 账户概览 · 市场要闻',
    icon: PulseIcon,
    className: 'luo-overview',
    View: OverviewPanel,
  },
  {
    id: 'positions',
    label: '持仓',
    hint: '账本 · 成交 · 绩效快照',
    icon: PortfolioIcon,
    className: null,
    View: PositionsPanel,
  },
  {
    id: 'watchlists',
    label: '关注',
    hint: '关注列表 · 手动管理 · AI 协作',
    icon: WatchlistIcon,
    className: 'luo-watchlists',
    View: WatchlistsPanel,
  },
  {
    id: 'strategies',
    label: '策略',
    hint: '研究问题 · 规则对照 · 持续优化',
    icon: LayersIcon,
    className: 'luo-strategies',
    View: StrategiesPanel,
  },
  {
    id: 'review',
    label: '复盘',
    hint: '建议表现 · 校准 · 待补观察',
    icon: RewindIcon,
    className: null,
    View: ReviewPanel,
  },
];

export const DEFAULT_VIEW = VIEWS[0].id;
const VIEW_KEY = 'luoome.view';

export const isKnownView = (id) => VIEWS.some((view) => view.id === id);

/** 记住上次停留的视图：只记界面位置，不记任何授权或账户信息。 */
export const readStoredView = (storage) => {
  try {
    const stored = storage?.getItem(VIEW_KEY) ?? null;
    return isKnownView(stored) ? stored : null;
  } catch {
    return null;
  }
};

export const writeStoredView = (storage, id) => {
  try {
    storage?.setItem(VIEW_KEY, id);
  } catch {
    // 存储不可用时只影响视图记忆，不影响使用。
  }
};

const Tabs = ({ views, activeId, onSelect }) =>
  h(
    'nav',
    { className: 'luo-app-tabs', 'aria-label': '业务视图' },
    views.map((view) =>
      h(
        'button',
        {
          key: view.id,
          type: 'button',
          className: cx('luo-app-tab', view.id === activeId && 'is-active'),
          'aria-current': view.id === activeId ? 'page' : undefined,
          'data-luoome-view': view.id,
          title: view.hint,
          onClick: () => onSelect(view.id),
        },
        h(view.icon, null),
        h('span', null, view.label),
      ),
    ),
  );

export function App(props) {
  const [viewId, setViewId] = useState(
    () => readStoredView(globalThis.sessionStorage) ?? DEFAULT_VIEW,
  );
  const select = useCallback((next) => {
    setViewId(next);
    writeStoredView(globalThis.sessionStorage, next);
  }, []);
  const active = VIEWS.find((view) => view.id === viewId) ?? VIEWS[0];
  return h(
    Panel,
    { className: cx('luo-app', active.className) },
    h(Tabs, { views: VIEWS, activeId: active.id, onSelect: select }),
    h(active.View, props),
  );
}
