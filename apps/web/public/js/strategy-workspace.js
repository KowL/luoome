import { invalidateBacktestCache, renderStrategyActions } from './strategy-workspace-backtest.js';
import { invalidateCycleCache, renderDecisionCycles } from './strategy-workspace-cycle.js';
import {
  invalidateExperimentCache,
  renderStrategyExperiment,
} from './strategy-workspace-experiment.js';
import { invalidateInsightsCache, renderInsights } from './strategy-workspace-insights.js';
import {
  invalidateOverviewCache,
  renderHealthBanner,
  renderOverview,
  renderPool,
} from './strategy-workspace-overview.js';
import {
  ADVANCED_TABS,
  BASIC_TABS,
  buildStrategyHash,
  parseStrategyHash,
  TAB_LABELS,
} from './strategy-workspace-route.js';
import { invalidateRunsCache, renderRuns } from './strategy-workspace-runs.js';
import { invalidateSettingsCache, renderSettings } from './strategy-workspace-settings.js';
import {
  badge,
  createFeatureCache,
  el,
  errorText,
  fmtDateTime,
  mount,
  PUBLICATION_STATUS,
  STRATEGY_STATUS,
} from './strategy-workspace-shared.js';

let requestEpoch = 0;
const featureCache = createFeatureCache();
const { cachedGet } = featureCache;
const invalidateFeatures = [
  invalidateOverviewCache,
  invalidateExperimentCache,
  invalidateRunsCache,
  invalidateInsightsCache,
  invalidateCycleCache,
  invalidateSettingsCache,
  invalidateBacktestCache,
];

export const invalidateStrategyWorkspaceCache = () => {
  featureCache.clear();
  for (const invalidate of invalidateFeatures) invalidate();
};

const navigate = (state, patch) => {
  window.location.hash = buildStrategyHash({ ...state, ...patch });
};

const renderTabContent = async (workspace, state, setStatus, refresh) => {
  const strategyId = workspace.strategy.id;
  if (state.tab === 'overview') return renderOverview(workspace, state);
  if (state.tab === 'experiment') return renderStrategyExperiment(strategyId, setStatus, refresh);
  if (state.tab === 'pool') return renderPool(strategyId, setStatus);
  if (state.tab === 'runs') return renderRuns(strategyId, state.scope ?? 'operational');
  if (state.tab === 'insights')
    return renderInsights(strategyId, setStatus, state.scope ?? 'operational', state);
  if (state.tab === 'cycle') return renderDecisionCycles(strategyId, state);
  return renderSettings(strategyId, setStatus, refresh);
};

const renderWorkspaceDetail = async (strategyId, state, setStatus, epoch) => {
  const root = document.querySelector('#strategy-detail');
  if (root === null) return;
  mount(root, el('p', 'placeholder', '加载策略工作台…'));
  const result = await cachedGet(`/api/strategies/${encodeURIComponent(strategyId)}/workspace`);
  if (epoch !== requestEpoch) return;
  if (!result.ok) {
    mount(root, el('p', 'status error', errorText(result)));
    return;
  }
  const workspace = result.data;
  const rerender = async () => {
    const nextEpoch = ++requestEpoch;
    await renderWorkspaceDetail(
      strategyId,
      parseStrategyHash(window.location.hash),
      setStatus,
      nextEpoch,
    );
  };
  const tabs = el('div', 'strategy-tabs');
  tabs.setAttribute('role', 'tablist');
  const makeTabButton = (key) => {
    const button = el('button', state.tab === key ? 'active' : '', TAB_LABELS[key]);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(state.tab === key));
    button.tabIndex = state.tab === key ? 0 : -1;
    button.addEventListener('click', () => navigate(state, { tab: key }));
    return button;
  };
  const tabButtons = [];
  for (const key of BASIC_TABS) {
    const button = makeTabButton(key);
    tabs.append(button);
    tabButtons.push(button);
  }
  // 高级 tab（实验 / AI 洞察 / 闭环）收进折叠分组；当前 tab 命中高级组时分组展开并高亮入口
  const advancedOpen = ADVANCED_TABS.includes(state.tab);
  const advanced = el('details', 'strategy-tabs-advanced');
  if (advancedOpen) advanced.open = true;
  advanced.append(el('summary', advancedOpen ? 'active' : '', '高级'));
  for (const key of ADVANCED_TABS) {
    const button = makeTabButton(key);
    advanced.append(button);
    tabButtons.push(button);
  }
  tabs.append(advanced);
  tabs.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const current = tabButtons.indexOf(document.activeElement);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = (Math.max(0, current) + delta + tabButtons.length) % tabButtons.length;
    tabButtons[next]?.focus();
    tabButtons[next]?.click();
  });
  const panel = el('div', 'strategy-tab-panel');
  panel.setAttribute('role', 'tabpanel');
  panel.append(el('p', 'placeholder', '加载视图…'));
  mount(root, [
    el('article', 'strategy-workspace', [
      el('header', 'strategy-workspace-head', [
        el('div', null, [
          el('div', 'flex gap-2', [
            el('h2', null, workspace.strategy.name),
            badge(STRATEGY_STATUS[workspace.strategy.status], workspace.strategy.status),
            ...(workspace.currentVersion
              ? [el('span', 'badge badge-neutral', `v${workspace.currentVersion.version}`)]
              : []),
            ...(workspace.currentRun
              ? [
                  badge(
                    PUBLICATION_STATUS[workspace.currentRun.publication?.status] ?? null,
                    workspace.currentRun.publication?.status ?? 'legacy/unknown',
                  ),
                ]
              : []),
          ]),
          el('p', 'muted', workspace.strategy.description),
          el(
            'div',
            'strategy-workspace-meta',
            workspace.currentRun
              ? `数据截止 ${fmtDateTime(workspace.currentRun.dataAsOf)} · 可用运行 ${fmtDateTime(workspace.currentRun.finishedAt ?? workspace.currentRun.startedAt)}`
              : '尚无可用运行',
          ),
        ]),
        renderStrategyActions(workspace, setStatus, rerender),
      ]),
      renderHealthBanner(workspace),
      tabs,
      panel,
    ]),
  ]);
  const content = await renderTabContent(workspace, state, setStatus, rerender);
  if (epoch !== requestEpoch) return;
  mount(panel, content);
};

export const renderStrategyWorkspacePage = async ({
  setStatus,
  preferredStrategyId = '',
  onSelect = () => {},
}) => {
  const epoch = ++requestEpoch;
  const list = document.querySelector('#strategies-list');
  const detail = document.querySelector('#strategy-detail');
  if (list === null || detail === null) return;
  const state = parseStrategyHash(window.location.hash);
  const result = await cachedGet('/api/strategies');
  if (epoch !== requestEpoch) return;
  if (!result.ok) {
    mount(list, el('p', 'status error', errorText(result)));
    return;
  }
  const strategies = result.data.strategies ?? [];
  if (
    state.strategyId.length === 0 &&
    preferredStrategyId.length > 0 &&
    strategies.some((strategy) => strategy.id === preferredStrategyId)
  ) {
    window.location.hash = buildStrategyHash({
      ...state,
      strategyId: preferredStrategyId,
      tab: 'settings',
    });
    return;
  }
  if (
    state.strategyId.length === 0 &&
    preferredStrategyId.length > 0 &&
    !strategies.some((strategy) => strategy.id === preferredStrategyId)
  ) {
    onSelect('');
  }
  const meta = document.querySelector('#strategies-meta');
  if (meta !== null) meta.textContent = `${strategies.length} 个`;
  mount(
    list,
    strategies.length === 0
      ? el('div', 'strategy-empty-state compact', [
          el('strong', null, '尚无策略'),
          el('p', 'muted', '从右上角新增策略或复制内置模板。'),
        ])
      : strategies.map((strategy) => {
          const row = el('button', 'strategy-catalog-item', [
            el('span', 'strategy-catalog-copy', [
              el('strong', null, strategy.name),
              el('small', null, strategy.description),
            ]),
            badge(STRATEGY_STATUS[strategy.status], strategy.status),
          ]);
          row.type = 'button';
          if (strategy.id === state.strategyId) row.classList.add('selected');
          row.addEventListener('click', () => {
            onSelect(strategy.id);
            navigate(state, { strategyId: strategy.id, tab: 'overview', runId: undefined });
          });
          return row;
        }),
  );
  if (state.strategyId.length === 0) {
    mount(
      detail,
      el('div', 'strategy-empty-state', [
        el('span', 'section-kicker', 'STRATEGY WORKSPACE'),
        el('h2', null, '选择策略查看工作台'),
        el('p', 'muted', '查看当前股票池、候选、运行 Diff 和不可变版本。'),
      ]),
    );
    return;
  }
  if (!strategies.some((strategy) => strategy.id === state.strategyId)) {
    mount(detail, el('p', 'status error', '所选 Strategy 不存在或已不可见。'));
    return;
  }
  onSelect(state.strategyId);
  await renderWorkspaceDetail(state.strategyId, state, setStatus, epoch);
};
