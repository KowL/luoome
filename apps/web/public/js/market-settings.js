/* 行情源设置：开关、路由优先级与即时应用。 */

import { callApi } from './api.js';
import { $ } from './ui.js';

let sources = [];
let initialized = false;

const setPanelState = (message, kind = '') => {
  const state = $('#market-settings-state');
  if (state === null) return;
  state.className = `ai-settings-state${kind === '' ? '' : ` ${kind}`}`;
  state.querySelector('span:last-child').textContent = message;
};

const activeSourceIds = (items) =>
  items
    .filter((source) => source.enabled)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((source) => source.id);

const normalizePriorities = () => {
  let priority = 1;
  for (const source of sources) {
    source.priority = source.enabled ? priority++ : null;
  }
};

const moveSource = (id, delta) => {
  const current = sources.findIndex((source) => source.id === id);
  if (current < 0 || !sources[current].enabled) return;
  const target = current + delta;
  if (target < 0 || target >= sources.length || !sources[target].enabled) return;
  [sources[current], sources[target]] = [sources[target], sources[current]];
  normalizePriorities();
};

const sourceRow = (source, index) => {
  const row = document.createElement('article');
  row.className = `market-source-row${source.enabled ? ' enabled' : ''}`;
  row.dataset.sourceId = source.id;

  const rank = document.createElement('span');
  rank.className = 'market-source-rank';
  rank.textContent = source.enabled ? String(source.priority).padStart(2, '0') : '—';

  const copy = document.createElement('div');
  copy.className = 'market-source-copy';
  const title = document.createElement('strong');
  title.textContent = source.label;
  const id = document.createElement('code');
  id.textContent = source.id;
  const description = document.createElement('p');
  description.textContent = source.description;
  const status = document.createElement('span');
  status.className = `market-source-status ${source.configured ? 'ready' : 'blocked'}`;
  status.textContent = source.configured ? 'READY' : (source.configurationHint ?? 'NOT CONFIGURED');
  copy.append(title, id, description, status);

  const controls = document.createElement('div');
  controls.className = 'market-source-controls';
  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'market-source-toggle';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = source.enabled;
  toggle.disabled = !source.configured;
  toggle.setAttribute('aria-label', `${source.enabled ? '停用' : '启用'} ${source.label}`);
  const switchTrack = document.createElement('span');
  switchTrack.setAttribute('aria-hidden', 'true');
  toggleLabel.append(toggle, switchTrack);

  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'market-order-btn';
  up.textContent = '↑';
  up.title = '提高优先级';
  up.disabled = !source.enabled || index === 0;
  const down = document.createElement('button');
  down.type = 'button';
  down.className = 'market-order-btn';
  down.textContent = '↓';
  down.title = '降低优先级';
  down.disabled =
    !source.enabled || index === sources.filter((candidate) => candidate.enabled).length - 1;

  toggle.addEventListener('change', () => {
    source.enabled = toggle.checked;
    sources = [
      ...sources.filter((candidate) => candidate.enabled),
      ...sources.filter((candidate) => !candidate.enabled),
    ];
    normalizePriorities();
    renderSourceList();
  });
  up.addEventListener('click', () => {
    moveSource(source.id, -1);
    renderSourceList();
  });
  down.addEventListener('click', () => {
    moveSource(source.id, 1);
    renderSourceList();
  });
  controls.append(toggleLabel, up, down);
  row.append(rank, copy, controls);
  return row;
};

const renderSourceList = () => {
  const list = $('#market-source-list');
  if (list === null) return;
  list.replaceChildren(...sources.map(sourceRow));
};

const renderMarketSettings = async (setStatus) => {
  setPanelState('正在读取路由');
  const result = await callApi('/api/settings/market');
  if (!result.ok) {
    setPanelState('路由不可用', 'error');
    setStatus(
      `行情源设置加载失败：${result.error?.message ?? result.error?.kind ?? 'unknown'}`,
      true,
    );
    return;
  }
  const data = result.data;
  const rows = Array.isArray(data.sources) ? data.sources : [];
  sources = [
    ...rows.filter((source) => source.enabled).sort((a, b) => a.priority - b.priority),
    ...rows.filter((source) => !source.enabled),
  ].map((source) => ({ ...source }));
  normalizePriorities();
  renderSourceList();
  $('#market-secret-path').textContent = data.secretPath;
  $('#market-secret-path').title = data.secretPath;
  if (data.configError) {
    setPanelState('配置需要修复', 'error');
    setStatus('现有行情源配置无效，请重新选择并保存。', true);
  } else {
    setPanelState(`${activeSourceIds(sources).length} 个数据源已启用`, 'ready');
  }
};

const saveMarketSettings = async (setStatus) => {
  const enabled = activeSourceIds(sources);
  if (enabled.length === 0) {
    setPanelState('至少保留一个数据源', 'error');
    setStatus('行情源设置保存失败：至少启用一个数据源。', true);
    return;
  }
  const button = $('#btn-market-save');
  button.disabled = true;
  setPanelState('正在应用路由');
  const result = await callApi('/api/settings/market', {
    method: 'POST',
    body: JSON.stringify({ sources: enabled }),
  });
  button.disabled = false;
  if (!result.ok) {
    setPanelState('保存失败', 'error');
    setStatus(
      `行情源设置保存失败：${result.error?.message ?? result.error?.required ?? result.error?.kind ?? 'unknown'}`,
      true,
    );
    return;
  }
  button.classList.add('saved');
  button.textContent = '✓ 路由已生效';
  window.setTimeout(() => {
    button.classList.remove('saved');
    button.innerHTML = '<span aria-hidden="true">▣</span> 保存路由并应用';
  }, 1_500);
  setStatus(`行情路由已更新：${enabled.join(' → ')}`);
  await renderMarketSettings(setStatus);
};

const initMarketSettings = (setStatus) => {
  if (initialized) return;
  initialized = true;
  $('#market-settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveMarketSettings(setStatus);
  });
};

export { activeSourceIds, initMarketSettings, renderMarketSettings, saveMarketSettings };
