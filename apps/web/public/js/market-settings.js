/* 行情源设置：开关、路由优先级、运行状态展开与即时应用。 */

import { callApi } from './api.js';
import { $ } from './ui.js';

let sources = [];
const expandedIds = new Set();
/** 正在进行探测的源 id；非 null 时禁用全部测试按钮防并发。 */
let testingId = null;
let reportStatus = () => {};
let initialized = false;

const HEALTH_LABELS = {
  fresh: '新鲜',
  stale: '过期',
  unavailable: '不可用',
  unknown: '未知',
  off: '未启用',
};

const fmtTime = (value) => {
  if (value === null || value === undefined) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', { hour12: false });
};

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

/** capability 运行态 badge；bound=false（能力边界之外）不画状态。 */
const capabilityStateCell = (capability) => {
  if (!capability.bound) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = '—';
    return span;
  }
  const state = capability.state ?? 'unknown';
  const badge = document.createElement('span');
  badge.className = `market-capability-state ${state}`;
  badge.textContent = HEALTH_LABELS[state] ?? state;
  return badge;
};

/** 源行展开区：能力 × 运行态表（观测为进程内存态，表头注明语义）。 */
const capabilityDetail = (source) => {
  const detail = document.createElement('div');
  detail.className = 'market-source-detail';
  const note = document.createElement('p');
  note.className = 'muted market-source-detail-note';
  note.textContent = '运行态为本次进程观测；保存路由后重新统计。';
  const table = document.createElement('table');
  table.className = 'table market-capability-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const text of ['能力', '状态', '最近成功', '数据截至', '最近错误']) {
    const th = document.createElement('th');
    th.textContent = text;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const capability of source.capabilities ?? []) {
    const tr = document.createElement('tr');
    if (!capability.bound) tr.className = 'unbound';
    const name = document.createElement('td');
    name.textContent = capability.label ?? capability.capability;
    const state = document.createElement('td');
    state.append(capabilityStateCell(capability));
    const lastSuccess = document.createElement('td');
    lastSuccess.textContent = fmtTime(capability.lastSuccessAt);
    const dataAsOf = document.createElement('td');
    dataAsOf.textContent = fmtTime(capability.dataAsOf);
    const lastError = document.createElement('td');
    lastError.className = 'muted';
    lastError.textContent = capability.lastErrorKind ?? '';
    tr.append(name, state, lastSuccess, dataAsOf, lastError);
    body.append(tr);
  }
  table.append(head, body);
  detail.append(note, table);
  return detail;
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
  const description = document.createElement('p');
  description.textContent = source.description;
  const status = document.createElement('span');
  status.className = `market-source-status ${source.configured ? 'ready' : 'blocked'}`;
  status.textContent = source.configured ? 'READY' : (source.configurationHint ?? 'NOT CONFIGURED');
  const health = document.createElement('span');
  const healthKind = source.health ?? (source.enabled ? 'unknown' : 'off');
  health.className = `market-source-health ${healthKind}`;
  const dot = document.createElement('i');
  dot.className = 'market-source-health-dot';
  dot.setAttribute('aria-hidden', 'true');
  const healthText = document.createElement('span');
  healthText.textContent = HEALTH_LABELS[healthKind] ?? healthKind;
  health.append(dot, healthText);
  copy.append(title, description, status, health);

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

  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'market-order-btn market-expand-btn';
  const isExpanded = expandedIds.has(source.id);
  expand.textContent = isExpanded ? '▴' : '▾';
  expand.title = isExpanded ? '收起能力状态' : '展开能力状态';
  expand.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
  expand.addEventListener('click', () => {
    if (expandedIds.has(source.id)) {
      expandedIds.delete(source.id);
    } else {
      expandedIds.add(source.id);
    }
    renderSourceList();
  });

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
  const test = document.createElement('button');
  test.type = 'button';
  test.className = 'market-order-btn market-test-btn';
  test.disabled = !source.enabled || testingId !== null;
  test.textContent = testingId === source.id ? '…' : '测试';
  test.title = source.enabled ? '主动探测该源全部能力并刷新状态' : '启用该源后才能探测';
  test.addEventListener('click', () => void testSource(source));
  controls.append(test, expand);
  row.append(rank, copy, controls);
  if (isExpanded) row.append(capabilityDetail(source));
  return row;
};

const renderSourceList = () => {
  const list = $('#market-source-list');
  if (list === null) return;
  list.replaceChildren(...sources.map(sourceRow));
};

/** 配置态 + 运行态视图 → 本地状态并重绘（GET 与探测响应共用）。 */
const applySettingsView = (data) => {
  const rows = Array.isArray(data?.sources) ? data.sources : [];
  sources = [
    ...rows.filter((source) => source.enabled).sort((a, b) => a.priority - b.priority),
    ...rows.filter((source) => !source.enabled),
  ].map((source) => ({ ...source }));
  normalizePriorities();
  renderSourceList();
  $('#market-secret-path').textContent = data.secretPath;
  $('#market-secret-path').title = data.secretPath;
};

/** 「测试」按钮：主动探测该源全部能力（server 逐项执行并记录观测），完成后用响应里的视图刷新状态。 */
const testSource = async (source) => {
  if (testingId !== null) return;
  testingId = source.id;
  setPanelState(`正在测试 ${source.label}`);
  renderSourceList();
  const result = await callApi(`/api/settings/market/${source.id}/test`, {
    method: 'POST',
    timeoutMs: 180_000,
  });
  testingId = null;
  if (!result.ok) {
    setPanelState('测试失败', 'error');
    reportStatus(
      `探测 ${source.label} 失败：${result.error?.message ?? result.error?.cause ?? result.error?.kind ?? 'unknown'}`,
      true,
    );
    renderSourceList();
    return;
  }
  applySettingsView(result.data?.settings);
  const probes = Array.isArray(result.data?.probes) ? result.data.probes : [];
  const failed = probes.filter((probe) => probe.ok === false);
  const okCount = probes.filter((probe) => probe.ok === true).length;
  if (failed.length === 0) {
    setPanelState(`测试通过（${okCount} 项）`, 'ready');
    reportStatus(`${source.label} 探测通过 ${okCount} 项能力。`);
  } else {
    setPanelState(`${failed.length} 项能力失败`, 'error');
    reportStatus(
      `${source.label} 探测：${okCount} 项通过，${failed.length} 项失败（${failed
        .map((probe) => `${probe.capability}:${probe.errorKind ?? 'error'}`)
        .join('，')}）。`,
      true,
    );
  }
};

const renderMarketSettings = async (setStatus) => {
  reportStatus = setStatus;
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
  applySettingsView(data);
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
  reportStatus = setStatus;
  $('#market-settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveMarketSettings(setStatus);
  });
  $('#btn-market-refresh')?.addEventListener('click', () => {
    void renderMarketSettings(setStatus);
  });
};

export { activeSourceIds, initMarketSettings, renderMarketSettings, saveMarketSettings };
