// dsh-luoome 正式 client 入口（M4；plugin 详细设计 §8 UI/分发）。
//
// 由 DSH client-modules 通过 window.__ModuleLoader__.load 加载：factory 返回
// { name, inject, apply }，apply(ctx) 在官方 slot 上注册：
//   - main（keyed，key=`luoome-<panel>`）：看盘 / 持仓 / 关注 / 策略 / 复盘；
//   - sidebar.panellist：业务侧栏条目（id 保持 `luoome-*`）；
//   - settings.section：投资设置。
//
// 数据只走宿主认证的同源 GET /api/luoome/state?panel=...；不在 localStorage 存授权。
// React 与 react/jsx-runtime 由 loader 平台种子提供（构建时 external）。
import { createElement as h } from 'react';

import { sendStockAnalysis, writeComposerWithSessionFallback } from './composer.js';
import {
  researchRequestFor,
  stockResearchRequestFor,
  strategyOperationRequestFor,
  watchlistOperationRequestFor,
} from './data.js';
import { OverviewPanel } from './overview.js';
import { PositionsPanel } from './positions.js';
import { ReviewPanel } from './review.js';
import { SettingsPanel } from './settings.js';
import { StrategiesPanel } from './strategies.js';
import { WatchlistsPanel } from './watchlists.js';

export const name = 'dsh-luoome';
/** 客户端运行时服务：slots 注册视图，layout 用于「在对话中研究此策略」的官方导航。 */
export const inject = ['slots', 'layout', 'sessions', 'uiWorkspace'];

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
const panels = [
  ['overview', '看盘', '市场温度 · 账户概览 · 今日触发', PulseIcon, OverviewPanel],
  ['positions', '持仓', '账本 · 成交 · 绩效快照', PortfolioIcon, PositionsPanel],
  ['watchlists', '关注', '关注列表 · 手动管理 · AI 协作', WatchlistIcon, WatchlistsPanel],
  ['strategies', '策略', '研究问题 · 规则对照 · 持续优化', LayersIcon, StrategiesPanel],
  ['review', '复盘', '建议表现 · 校准 · 待补观察', RewindIcon, ReviewPanel],
];

/**
 * 「在对话中研究此策略」：记录携带 strategyId/runId 的请求，经官方 layout 服务
 * 导航到会话面板，并把研究提示写入输入框（不自动提交，仍由用户明确表达操作意图）。
 */
const openPromptInConversation = (ctx, request, stateKey) => {
  if (typeof window !== 'undefined') {
    window[stateKey] = { ...request, at: new Date().toISOString() };
    const completion = writeComposerWithSessionFallback(ctx, request.prompt)
      .then((result) => {
        window[stateKey] = { ...window[stateKey], ...result };
        return { ok: true };
      })
      .catch(() => {
        window[stateKey] = { ...window[stateKey], errorCode: 'client/composer-unavailable' };
        return { ok: false };
      });
    return { ...request, completion };
  }
  return request;
};

export const openResearchInConversation = (ctx, strategyId, runId = null, context = {}) =>
  openPromptInConversation(
    ctx,
    researchRequestFor(strategyId, runId, context),
    '__luoomeLastResearchRequest',
  );

export const openStrategyOperationInConversation = (ctx, strategyId, context = {}) =>
  openPromptInConversation(
    ctx,
    strategyOperationRequestFor(strategyId, context),
    '__luoomeLastStrategyOperationRequest',
  );

export const openWatchlistOperationInConversation = (ctx, watchlist) =>
  openPromptInConversation(
    ctx,
    watchlistOperationRequestFor(watchlist),
    '__luoomeLastWatchlistOperationRequest',
  );

export const openStockAnalysisInConversation = async (ctx, context) => {
  const request = stockResearchRequestFor(context);
  if (typeof window !== 'undefined')
    window.__luoomeLastStockAnalysisRequest = { ...request, state: 'sending' };
  try {
    const sessionId = await sendStockAnalysis(ctx, request);
    if (typeof window !== 'undefined')
      window.__luoomeLastStockAnalysisRequest = { ...request, sessionId, state: 'submitted' };
  } catch (error) {
    if (typeof window !== 'undefined')
      window.__luoomeLastStockAnalysisRequest = {
        ...request,
        state: 'failed',
        errorCode: error.code ?? 'client/unavailable',
      };
    throw error;
  }
};

export function apply(ctx) {
  // Pocket 的抽屉导航尚未识别原生 panel slot；选中 luoome 面板后归还手机屏幕。
  ctx.effect(() => {
    const onNavigate = (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest('button');
      if (!button?.querySelector('[data-luoome-panel]')) return;
      if (button.closest('[data-mobile-nav="frame"]:not([data-sidebar-collapsed])'))
        ctx.layout.toggleSidebar();
    };
    document.addEventListener('click', onNavigate);
    return () => document.removeEventListener('click', onNavigate);
  }, 'luoome: close mobile drawer after panel navigation');
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'luoome-settings', order: 40, label: () => '投资设置' },
      SettingsPanel,
    ),
  );
  for (const [panel, title, subtitle, Icon, View] of panels) {
    const id = `luoome-${panel}`;
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        {
          name: 'main',
          key: id,
          inject: () => ({
            panel,
            title,
            subtitle,
            onResearch: (strategyId, runId, context) =>
              openResearchInConversation(ctx, strategyId, runId, context),
            onManage: (strategyId, context) =>
              openStrategyOperationInConversation(ctx, strategyId, context),
            onManageWatchlist: (watchlist) => openWatchlistOperationInConversation(ctx, watchlist),
            onAnalyzeStock: (context) => openStockAnalysisInConversation(ctx, context),
          }),
        },
        View,
      ),
    );
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register({ name: 'sidebar.panellist', id, order: 20, label: () => title }, () =>
        h('span', { 'data-luoome-panel': panel }, h(Icon, null)),
      ),
    );
  }
}
