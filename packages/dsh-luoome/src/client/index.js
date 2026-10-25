// dsh-luoome 正式 client 入口（M4；plugin 详细设计 §8 UI/分发）。
//
// 由 DSH client-modules 通过 window.__ModuleLoader__.load 加载：factory 返回
// { name, inject, apply }，apply(ctx) 在官方 slot 上注册：
//   - main（keyed，key=`luoome-<panel>`）：看盘 / 持仓 / 策略 / 复盘 / 投资设置；
//   - sidebar.panellist：五个侧栏条目（id 保持 `luoome-*`）。
//
// 数据只走宿主认证的同源 GET /api/luoome/state?panel=...；不在 localStorage 存授权。
// React 与 react/jsx-runtime 由 loader 平台种子提供（构建时 external）。
import { createElement as h } from 'react';

import { sendStockAnalysis, writeComposer } from './composer.js';
import { researchRequestFor, stockResearchRequestFor } from './data.js';
import { OverviewPanel } from './overview.js';
import { PositionsPanel } from './positions.js';
import { ReviewPanel } from './review.js';
import { SettingsPanel } from './settings.js';
import { StrategiesPanel } from './strategies.js';

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
const SettingsIcon = () =>
  icon(['M3 4h10', 'M3 8h10', 'M3 12h10', 'M6 2.5v3', 'M10 6.5v3', 'M6 10.5v3']);

const panels = [
  ['overview', '看盘', '市场温度 · 持仓 · 今日触发', PulseIcon, OverviewPanel],
  ['positions', '持仓', '账本 · 成交 · 绩效快照', PortfolioIcon, PositionsPanel],
  ['strategies', '策略', '筛选条件 · 匹配标的 · 运行结果', LayersIcon, StrategiesPanel],
  ['review', '复盘', '建议表现 · 校准 · 待补观察', RewindIcon, ReviewPanel],
  ['settings', '投资设置', '账户 · 数据健康 · 自动任务', SettingsIcon, SettingsPanel],
];

/**
 * 「在对话中研究此策略」：记录携带 strategyId/runId 的请求，经官方 layout 服务
 * 导航到会话面板，并把研究提示写入输入框（不自动提交，写操作仍需用户确认）。
 */
export const openResearchInConversation = (ctx, strategyId, runId = null, context = {}) => {
  const request = researchRequestFor(strategyId, runId, context);
  if (typeof window !== 'undefined')
    window.__luoomeLastResearchRequest = { ...request, at: new Date().toISOString() };
  try {
    ctx?.layout?.selectPanel?.('conversation');
  } catch {
    // 会话面板不可用时不阻塞，用户仍可在策略面板看到请求内容。
  }
  if (typeof window !== 'undefined') {
    // 面板切换后 composer 才挂载，给它几次机会而不是只赌一次。
    let written = false;
    for (const delay of [80, 240, 600, 1200, 2400])
      setTimeout(() => {
        if (!written) written = writeComposer(request.prompt);
      }, delay);
  }
  return request;
};

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
            onAnalyzeStock: (context) => openStockAnalysisInConversation(ctx, context),
          }),
        },
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
