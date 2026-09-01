export const STRATEGY_TABS = new Set([
  'overview',
  'experiment',
  'pool',
  'runs',
  'insights',
  'cycle',
  'settings',
]);

export const TAB_LABELS = {
  overview: '概览',
  experiment: '实验',
  pool: '股票池',
  runs: '执行记录',
  insights: 'AI 洞察',
  cycle: '闭环',
  settings: '设置',
};

export const parseStrategyHash = (hash) => {
  const raw = String(hash ?? '').replace(/^#/, '');
  const queryIndex = raw.indexOf('?');
  const params = new URLSearchParams(queryIndex === -1 ? '' : raw.slice(queryIndex + 1));
  const tab = params.get('tab') ?? 'overview';
  const scope = params.get('scope');
  return {
    strategyId: params.get('strategyId') ?? '',
    tab: STRATEGY_TABS.has(tab) ? tab : 'overview',
    ...(scope === 'evaluation' ? { scope: 'evaluation' } : {}),
    ...(params.has('runId') ? { runId: params.get('runId') ?? '' } : {}),
    ...(params.has('compareRunId') ? { compareRunId: params.get('compareRunId') ?? '' } : {}),
  };
};

export const buildStrategyHash = (state) => {
  const params = new URLSearchParams();
  if (state.strategyId) params.set('strategyId', state.strategyId);
  params.set('tab', STRATEGY_TABS.has(state.tab) ? state.tab : 'overview');
  if (state.scope === 'evaluation') params.set('scope', 'evaluation');
  if (state.runId) params.set('runId', state.runId);
  if (state.compareRunId) params.set('compareRunId', state.compareRunId);
  return `#strategies?${params.toString()}`;
};
