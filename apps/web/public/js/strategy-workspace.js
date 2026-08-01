import { callApi } from './api.js';
import { closeModal, confirmDialog, openModal, promptDialog } from './modal.js';
import { stockIdentityLink } from './stock-link.js';
import { $, el, fmtDateTime, mount } from './ui.js';

const STRATEGY_TABS = new Set(['overview', 'pool', 'candidates', 'runs', 'insights', 'settings']);
const CANDIDATE_VIEWS = new Set(['rule-near-miss', 'ranking-near-miss', 'incomplete']);

export const parseStrategyHash = (hash) => {
  const raw = String(hash ?? '').replace(/^#/, '');
  const queryIndex = raw.indexOf('?');
  const params = new URLSearchParams(queryIndex === -1 ? '' : raw.slice(queryIndex + 1));
  const tab = params.get('tab') ?? 'overview';
  const candidateView = params.get('view') ?? 'rule-near-miss';
  return {
    strategyId: params.get('strategyId') ?? '',
    tab: STRATEGY_TABS.has(tab) ? tab : 'overview',
    ...(params.has('runId') ? { runId: params.get('runId') ?? '' } : {}),
    ...(params.has('compareRunId') ? { compareRunId: params.get('compareRunId') ?? '' } : {}),
    candidateView: CANDIDATE_VIEWS.has(candidateView) ? candidateView : 'rule-near-miss',
  };
};

export const buildStrategyHash = (state) => {
  const params = new URLSearchParams();
  if (state.strategyId) params.set('strategyId', state.strategyId);
  params.set('tab', STRATEGY_TABS.has(state.tab) ? state.tab : 'overview');
  if (state.runId) params.set('runId', state.runId);
  if (state.compareRunId) params.set('compareRunId', state.compareRunId);
  params.set(
    'view',
    CANDIDATE_VIEWS.has(state.candidateView) ? state.candidateView : 'rule-near-miss',
  );
  return `#strategies?${params.toString()}`;
};

const TAB_LABELS = {
  overview: '概览',
  pool: '股票池',
  candidates: '候选池',
  runs: '执行记录',
  insights: 'AI 洞察',
  settings: '设置',
};
const STRATEGY_STATUS = {
  active: ['运行中', 'badge-active'],
  draft: ['草稿', 'badge-draft'],
  paused: ['已暂停', 'badge-paused'],
  archived: ['已归档', 'badge-neutral'],
};
const RUN_STATUS = {
  complete: ['完整', 'badge-active'],
  partial: ['部分可用', 'badge-important'],
  failed: ['失败', 'badge-pos'],
  running: ['运行中', 'badge-neutral'],
};
const RULE_STATUS = {
  matched: ['命中', 'badge-active'],
  'not-matched': ['未命中', 'badge-neutral'],
  unknown: ['数据缺失', 'badge-important'],
  error: ['求值错误', 'badge-pos'],
};
const CANDIDATE_LABELS = {
  'rule-near-miss': '规则近失',
  'ranking-near-miss': '排名近失',
  incomplete: '数据不完整',
};
const RESULT_VIEW_STATUS = {
  selected: ['入选', 'badge-active'],
  'rule-near-miss': ['规则近失', 'badge-important'],
  'ranking-near-miss': ['排名近失', 'badge-neutral'],
  incomplete: ['数据不完整', 'badge-important'],
  excluded: ['未入选', 'badge-neutral'],
};

let requestEpoch = 0;
const responseCache = new Map();

const errorText = (result) => {
  const error = result?.error;
  if (error === undefined) return '请求失败';
  if (error.message) return error.message;
  if (error.cause) return error.cause;
  if (error.entity) return `${error.entity}不存在：${error.id ?? ''}`;
  return error.kind ?? '请求失败';
};

const cachedGet = async (path) => {
  if (responseCache.has(path)) return responseCache.get(path);
  const pending = callApi(path);
  responseCache.set(path, pending);
  const result = await pending;
  if (!result.ok) responseCache.delete(path);
  return result;
};

const post = (path, body) => callApi(path, { method: 'POST', body: JSON.stringify(body) });

const badge = (config, fallback) =>
  el('span', `badge ${config?.[1] ?? 'badge-neutral'}`, config?.[0] ?? fallback);

const navigate = (state, patch) => {
  const next = { ...state, ...patch };
  window.location.hash = buildStrategyHash(next);
};

const metric = (label, value, note = '') =>
  el('div', 'strategy-metric', [
    el('span', 'strategy-metric-label', label),
    el('strong', 'strategy-metric-value', value === undefined ? '--' : String(value)),
    ...(note.length === 0 ? [] : [el('small', null, note)]),
  ]);

const renderHealthBanner = (workspace) => {
  if ((workspace.warnings ?? []).length === 0) return null;
  return el(
    'div',
    `strategy-health-banner ${workspace.overview.health === 'failed' ? 'danger' : 'warning'}`,
    workspace.warnings.map((warning) => el('p', null, warning)),
  );
};

const ruleInputsText = (evaluation) => {
  if (!Array.isArray(evaluation.inputs) || evaluation.inputs.length === 0) return '无输入快照';
  return evaluation.inputs
    .map((input) =>
      input.status === 'missing'
        ? `${input.path}=缺失`
        : `${input.path}=${JSON.stringify(input.value)}`,
    )
    .join(' · ');
};

const ruleEvaluationPanel = (result) => {
  const panel = el('div', 'strategy-rule-evaluation');
  const evaluations = Array.isArray(result.ruleEvaluations) ? result.ruleEvaluations : [];
  if (evaluations.length === 0) {
    panel.append(el('p', 'placeholder', '该结果没有规则解释。'));
    return panel;
  }
  for (const evaluation of evaluations) {
    const status = RULE_STATUS[evaluation.status];
    const isV2 = evaluation.schemaVersion === 2;
    panel.append(
      el('article', 'strategy-rule-item', [
        el('div', 'flex gap-2', [
          el('strong', null, evaluation.ruleId),
          badge(status, evaluation.status),
          ...(isV2 ? [el('span', 'badge badge-neutral', evaluation.scope)] : []),
        ]),
        ...(isV2
          ? [
              el('code', 'strategy-expression', evaluation.expression),
              el('div', 'strategy-rule-inputs', ruleInputsText(evaluation)),
              el('p', null, evaluation.explanation?.message ?? '解释不可用'),
            ]
          : [el('p', 'status warning', '历史运行未保存详细解释，请重新运行当前版本。')]),
        ...(evaluation.error ? [el('p', 'status error', evaluation.error)] : []),
        ...((evaluation.evidence ?? []).length === 0
          ? []
          : [el('p', 'muted', `证据：${evaluation.evidence.join('；')}`)]),
      ]),
    );
  }
  return panel;
};

const addToWatchlist = async (stock, setStatus) => {
  const watchlists = await callApi('/api/watchlists');
  if (!watchlists.ok) {
    setStatus(errorText(watchlists), true);
    return;
  }
  const options = (watchlists.data.items ?? [])
    .filter(({ watchlist }) => watchlist.enabled && watchlist.kind !== 'system')
    .map(({ watchlist }) => ({ value: watchlist.id, label: watchlist.name }));
  if (options.length === 0) {
    setStatus('没有可手工添加的 Watchlist', true);
    return;
  }
  const values = await promptDialog({
    title: `加入 Watchlist · ${stock.stockName}`,
    fields: [{ key: 'watchlistId', label: '目标列表', value: options[0].value, options }],
    confirmLabel: '加入',
  });
  if (values === null) return;
  const result = await post(`/api/watchlists/${encodeURIComponent(values.watchlistId)}/members`, {
    stockId: stock.stockId,
    stage: 'discovered',
    priority: 'normal',
  });
  setStatus(result.ok ? `${stock.stockName} 已加入 Watchlist` : errorText(result), !result.ok);
};

const resultReason = (view) => {
  if (view.kind === 'rule-near-miss') return `阻断规则 ${view.blockingRuleIds.join('、')}`;
  if (view.kind === 'ranking-near-miss') {
    return `距 Top ${view.distance?.positionsAway ?? '--'} 位`;
  }
  if (view.kind === 'incomplete') return '数据或解释不完整';
  return view.result.selected ? '已入选' : '未入选';
};

const renderResultTable = (payload, setStatus) => {
  if ((payload.rows ?? []).length === 0) {
    return el('div', 'strategy-empty-state', [
      el('strong', null, '当前视图为空'),
      el('p', 'muted', `数据截止 ${fmtDateTime(payload.dataAsOf)}`),
    ]);
  }
  const body = el('tbody');
  for (const row of payload.rows) {
    const result = row.view.result;
    const detailId = `strategy-rule-${result.runId}-${result.stockId}`.replace(
      /[^a-zA-Z0-9_-]/g,
      '-',
    );
    const detailRow = el('tr', 'strategy-rule-row');
    detailRow.hidden = true;
    const detailCell = el('td');
    detailCell.colSpan = 7;
    detailCell.append(ruleEvaluationPanel(result));
    detailRow.append(detailCell);
    const explain = el('button', 'btn btn-outline btn-sm', '规则解释');
    explain.type = 'button';
    explain.setAttribute('aria-expanded', 'false');
    explain.setAttribute('aria-controls', detailId);
    explain.addEventListener('click', () => {
      detailRow.hidden = !detailRow.hidden;
      explain.setAttribute('aria-expanded', String(!detailRow.hidden));
    });
    detailRow.id = detailId;
    const research = el('a', 'btn btn-outline btn-sm', '研究档案');
    research.href = `#research?stockId=${encodeURIComponent(row.stock.stockId)}`;
    const watchlist = el('button', 'btn btn-outline btn-sm', '加入 Watchlist');
    watchlist.type = 'button';
    watchlist.addEventListener('click', () => void addToWatchlist(row.stock, setStatus));
    body.append(
      el('tr', null, [
        el('td', null, stockIdentityLink(row.stock)),
        el('td', 'num mono', result.rank ?? '--'),
        el('td', 'num mono', typeof result.score === 'number' ? result.score.toFixed(2) : '--'),
        el('td', null, resultReason(row.view)),
        el('td', 'mono muted', fmtDateTime(result.dataAsOf)),
        el('td', null, badge(RESULT_VIEW_STATUS[row.view.kind], row.view.kind)),
        el('td', null, el('div', 'row-actions', [explain, research, watchlist])),
      ]),
      detailRow,
    );
  }
  return el('div', 'table-wrap strategy-result-table', [
    el('table', 'table', [
      el(
        'thead',
        null,
        el('tr', null, [
          el('th', null, '股票'),
          el('th', 'num', '排名'),
          el('th', 'num', '规则分'),
          el('th', null, '状态 / 距离'),
          el('th', null, '数据截止'),
          el('th', null, '结果'),
          el('th', null, '操作'),
        ]),
      ),
      body,
    ]),
  ]);
};

const renderOverview = (workspace, state) => {
  const overview = workspace.overview;
  const current = workspace.currentRun;
  if (current === undefined) {
    const settings = el('button', 'btn btn-primary btn-sm', '前往设置');
    settings.type = 'button';
    settings.addEventListener('click', () => navigate(state, { tab: 'settings' }));
    return el('div', 'strategy-empty-state', [
      el('span', 'section-kicker', 'NO COMPLETE RUN'),
      el('h3', null, '尚无完整运行'),
      el('p', null, '发布有效版本后可进行样本试跑或正式运行。试跑不会成为当前股票池。'),
      settings,
    ]);
  }
  const grid = el('div', 'strategy-summary-grid', [
    metric('当前股票', overview.selectedCount),
    metric('规则近失', overview.ruleNearMissCount),
    metric('排名近失', overview.rankingNearMissCount),
    metric(
      '新增 / 退出',
      overview.enteredCount === undefined
        ? '--'
        : `${overview.enteredCount} / ${overview.exitedCount}`,
    ),
  ]);
  const providers = (current.providerStatuses ?? []).map((provider) =>
    el('span', `badge ${provider.ok ? 'badge-active' : 'badge-important'}`, provider.provider),
  );

  return el('div', null, [
    grid,
    el('section', 'strategy-overview-audit', [
      el('div', null, [
        el('span', 'strategy-metric-label', '当前有效运行'),
        el('strong', 'mono', fmtDateTime(current.finishedAt ?? current.startedAt)),
      ]),
      el('div', null, [
        el('span', 'strategy-metric-label', '数据截止'),
        el('strong', 'mono', fmtDateTime(current.dataAsOf)),
      ]),
      el('div', null, [
        el('span', 'strategy-metric-label', '数据来源'),
        el('div', 'flex gap-2', providers),
      ]),
    ]),
  ]);
};

const renderPool = async (strategyId, setStatus) => {
  const result = await cachedGet(
    `/api/strategies/${encodeURIComponent(strategyId)}/results?view=selected&sort=rank&order=asc&limit=200`,
  );
  if (!result.ok) return el('p', 'status error', errorText(result));
  return el('div', null, [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('h3', null, '当前股票池'),
        el('p', 'muted', '来自最近一次持久化完整运行'),
      ]),
      el('span', 'entity-count', `${result.data.total} 只`),
    ]),
    renderResultTable(result.data, setStatus),
  ]);
};

const renderCandidates = async (strategyId, state, setStatus) => {
  const tabs = el('div', 'strategy-candidate-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const [kind, label] of Object.entries(CANDIDATE_LABELS)) {
    const button = el(
      'button',
      `btn btn-sm ${state.candidateView === kind ? 'btn-primary' : 'btn-outline'}`,
      label,
    );
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(state.candidateView === kind));
    button.addEventListener('click', () => navigate(state, { candidateView: kind }));
    tabs.append(button);
  }
  const result = await cachedGet(
    `/api/strategies/${encodeURIComponent(strategyId)}/results?view=${encodeURIComponent(state.candidateView)}&rankingWindow=20&sort=rank&order=asc&limit=200`,
  );
  if (!result.ok) return el('div', null, [tabs, el('p', 'status error', errorText(result))]);
  return el('div', null, [
    tabs,
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('h3', null, CANDIDATE_LABELS[state.candidateView]),
        el(
          'p',
          'muted',
          state.candidateView === 'incomplete'
            ? '不计入候选数量，仅披露数据和解释缺口'
            : state.candidateView === 'ranking-near-miss'
              ? '展示 Top N 之后 20 名'
              : '仅包含 logic=all 且唯一确定性阻断规则',
        ),
      ]),
      el('span', 'entity-count', `${result.data.total} 只`),
    ]),
    renderResultTable(result.data, setStatus),
  ]);
};

const runSummaryText = (run) => {
  const summary = run.summary ?? {};
  if (summary.schemaVersion === 2) {
    return `覆盖 ${summary.universeCount} · 求值 ${summary.evaluatedCount} · 入选 ${summary.selectedCount} · 信号 ${summary.signalCount} · 不完整 ${summary.partialCount} · 失败 ${summary.failedCount}`;
  }
  return '历史运行摘要不完整';
};

/**
 * 运行详情弹窗内容：逐股结果 + StrategySignal。
 * 结果列表默认只展示命中的（selected === true），
 * 通过「只看命中 / 全部 N 条」切换查看全部；信号区保持不变。
 * 每条结果默认折叠为一行（股票 + rank + score），点击行展开规则详情；
 * 结果列表按页展示（默认每页 50 条），切换筛选回到第一页。
 * @param {object} data GET /api/strategy-runs/:id 的 data
 * @param {object} [options] { pageSize?: number } 每页条数（测试可缩小）
 * @returns {HTMLElement} 可直接放入弹窗 body 的节点
 */
export const buildRunDetailContent = (data, { pageSize = 50 } = {}) => {
  const identityById = new Map((data.stocks ?? []).map((stock) => [stock.stockId, stock]));
  const identity = (stockId) =>
    identityById.get(stockId) ?? { stockId, stockName: '名称暂缺', nameStatus: 'unavailable' };
  const results = data.results ?? [];
  const signals = data.signals ?? [];
  const resultRow = (result) => {
    const detail = el('div', 'strategy-run-result-detail', ruleEvaluationPanel(result));
    const row = el('article', 'strategy-run-result', [
      el('div', 'strategy-run-result-head', [
        stockIdentityLink(identity(result.stockId)),
        el('span', 'mono', `rank ${result.rank ?? '--'}`),
        el(
          'span',
          'mono',
          `score ${typeof result.score === 'number' ? result.score.toFixed(2) : '--'}`,
        ),
      ]),
      detail,
    ]);
    // 行本身即展开开关；点击行内股票链接不触发展开（沿用 advice-card 模式）
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-expanded', 'false');
    const toggle = () => {
      const expanded = row.classList.toggle('expanded');
      row.setAttribute('aria-expanded', String(expanded));
    };
    row.addEventListener('click', (event) => {
      if (event.target instanceof HTMLAnchorElement) return;
      toggle();
    });
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target instanceof HTMLAnchorElement) return;
      event.preventDefault();
      toggle();
    });
    return row;
  };
  const signalRow = (signal) =>
    el('div', 'entity-item', [
      stockIdentityLink(identity(signal.stockId)),
      el('span', 'mono', `${signal.direction} · score ${signal.score}`),
      el('p', 'muted', (signal.evidence ?? []).join('；')),
    ]);
  const selected = results.filter((result) => result.selected === true);
  const list = el('div', 'strategy-run-detail-results');
  const pager = el('div', 'strategy-run-pagination');
  const prev = el('button', 'btn btn-outline btn-sm', '上一页');
  const next = el('button', 'btn btn-outline btn-sm', '下一页');
  const pageInfo = el('span', 'muted mono', '');
  prev.type = 'button';
  next.type = 'button';
  let page = 1;
  let currentRows = selected;
  const pageCount = (rows) => Math.max(1, Math.ceil(rows.length / pageSize));
  const renderList = (rows) => {
    page = Math.min(page, pageCount(rows));
    const start = (page - 1) * pageSize;
    const slice = rows.slice(start, start + pageSize);
    list.replaceChildren(
      ...(slice.length === 0 ? [el('p', 'placeholder', '无逐股结果')] : slice.map(resultRow)),
    );
    prev.disabled = page <= 1;
    next.disabled = page >= pageCount(rows);
    pageInfo.textContent = `第 ${page} / ${pageCount(rows)} 页 · 共 ${rows.length} 条`;
    pager.hidden = rows.length === 0;
  };
  prev.addEventListener('click', () => {
    page -= 1;
    renderList(currentRows);
  });
  next.addEventListener('click', () => {
    page += 1;
    renderList(currentRows);
  });
  pager.append(prev, pageInfo, next);
  renderList(currentRows);
  const tabs = el('div', 'strategy-run-detail-tabs');
  const tab = (label, rows, active) => {
    const button = el('button', `btn btn-sm ${active ? 'btn-primary' : 'btn-outline'}`, label);
    button.type = 'button';
    button.addEventListener('click', () => {
      for (const other of tabs.children) {
        other.classList.remove('btn-primary');
        other.classList.add('btn-outline');
      }
      button.classList.remove('btn-outline');
      button.classList.add('btn-primary');
      // 切换筛选回到第一页
      page = 1;
      currentRows = rows;
      renderList(currentRows);
    });
    return button;
  };
  tabs.append(
    tab(`只看命中（${selected.length}）`, selected, true),
    tab(`全部 ${results.length} 条`, results, false),
  );
  return el('div', 'strategy-run-detail', [
    el('p', 'muted', `结果 ${results.length} · 信号 ${signals.length}`),
    tabs,
    list,
    pager,
    el('h4', null, 'StrategySignal'),
    ...(signals.length === 0 ? [el('p', 'placeholder', '无信号')] : signals.map(signalRow)),
  ]);
};

/** 点击运行记录「查看」：拉取运行详情并以弹窗展示。 */
export const openRunDetail = async (runId) => {
  const detail = await cachedGet(`/api/strategy-runs/${encodeURIComponent(runId)}`);
  openModal(
    '运行详情',
    detail.ok ? buildRunDetailContent(detail.data) : el('p', 'status error', errorText(detail)),
  );
};

const renderDiff = async (strategyId) => {
  const result = await cachedGet(
    `/api/strategy-runs/compare?strategyId=${encodeURIComponent(strategyId)}`,
  );
  if (!result.ok) return el('p', 'placeholder', '至少需要两次完整运行后才能比较。');
  const { diff, warnings } = result.data;
  const strip = el('div', 'strategy-diff-strip', [
    metric('新增', diff.summary.entered),
    metric('退出', diff.summary.exited),
    metric('候选转正', diff.summary.candidatePromoted),
    metric('排名变化', diff.summary.rankChanged),
  ]);
  const rows = diff.rows.filter((row) => !row.changes.includes('stayed') || row.changes.length > 1);
  const table =
    rows.length === 0
      ? el('p', 'placeholder', '两次完整运行没有实质变化。')
      : el('div', 'table-wrap', [
          el('table', 'table', [
            el(
              'thead',
              null,
              el('tr', null, [
                el('th', null, '股票'),
                el('th', null, '变化'),
                el('th', 'num', '排名 Δ'),
                el('th', 'num', '规则分 Δ'),
              ]),
            ),
            el(
              'tbody',
              null,
              rows.map((row) =>
                el('tr', null, [
                  el('td', null, stockIdentityLink(row.stock)),
                  el('td', null, row.changes.join(' · ')),
                  el('td', 'num mono', row.rankDelta ?? '--'),
                  el('td', 'num mono', row.scoreDelta ?? '--'),
                ]),
              ),
            ),
          ]),
        ]);
  return el('section', 'strategy-diff', [
    el('div', 'strategy-tab-heading', [
      el('h3', null, '最近两次完整运行 Diff'),
      el('span', 'mono muted', `${diff.fromRunId} → ${diff.toRunId}`),
    ]),
    ...(warnings ?? []).map((warning) => el('p', 'status warning', warning)),
    strip,
    table,
  ]);
};

export const renderRuns = async (strategyId) => {
  const result = await cachedGet(`/api/strategies/${encodeURIComponent(strategyId)}/runs`);
  if (!result.ok) return el('p', 'status error', errorText(result));
  const runs = result.data.runs ?? [];
  const body = el('tbody');
  for (const run of runs) {
    const view = el('button', 'btn btn-outline btn-sm', '查看');
    view.type = 'button';
    view.addEventListener('click', () => void openRunDetail(run.id));
    body.append(
      el('tr', null, [
        el('td', 'mono', fmtDateTime(run.startedAt)),
        el('td', null, run.mode),
        el('td', 'mono', run.strategyVersionId),
        el('td', null, badge(RUN_STATUS[run.status], run.status)),
        el('td', 'muted', runSummaryText(run)),
        el('td', null, view),
      ]),
    );
  }
  return el('div', null, [
    el('div', 'table-wrap strategy-run-timeline', [
      el('table', 'table', [
        el(
          'thead',
          null,
          el('tr', null, [
            el('th', null, '时间'),
            el('th', null, '模式'),
            el('th', null, '版本'),
            el('th', null, '状态'),
            el('th', null, '摘要'),
            el('th', null, '操作'),
          ]),
        ),
        body,
      ]),
    ]),
    await renderDiff(strategyId),
  ]);
};

const renderInsights = () =>
  el('div', 'strategy-empty-state', [
    el('span', 'section-kicker', 'FACT-BASED INSIGHTS'),
    el('h3', null, '真实信号观察将在 Phase B 启用'),
    el(
      'p',
      null,
      '届时只展示 SignalObservation 的样本数、窗口、缺失率和 benchmarkStatus，不展示收益承诺或未来概率。',
    ),
  ]);

const openVersionEditor = (strategy, latest, setStatus, refresh) => {
  const input = el('textarea', 'strategy-def-input');
  input.rows = 22;
  input.wrap = 'off';
  input.value = JSON.stringify(latest?.definition ?? {}, null, 2);
  const summary = el('input');
  summary.placeholder = '说明本次规则变化';
  const submit = el('button', 'btn btn-primary', '创建草案');
  submit.type = 'button';
  submit.addEventListener('click', async () => {
    let definition;
    try {
      definition = JSON.parse(input.value);
    } catch {
      setStatus('策略定义不是合法 JSON', true);
      return;
    }
    submit.disabled = true;
    const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/versions`, {
      definition,
      changeSummary: summary.value.trim() || 'Web 创建版本草案',
    });
    submit.disabled = false;
    if (!result.ok) {
      setStatus(errorText(result), true);
      return;
    }
    closeModal();
    responseCache.clear();
    setStatus(`v${result.data.version.version} 草案已创建`);
    await refresh();
  });
  openModal(
    `新版本草案 · ${strategy.name}`,
    el('div', 'modal-form', [
      el('p', 'hint', '发布版本不可原地修改；保存会创建新的不可变版本草案。'),
      summary,
      input,
      el('div', 'modal-actions', [submit]),
    ]),
  );
};

const renderSettings = async (strategyId, setStatus, refresh) => {
  const result = await cachedGet(`/api/strategies/${encodeURIComponent(strategyId)}`);
  if (!result.ok) return el('p', 'status error', errorText(result));
  const { strategy, versions } = result.data;
  const latest = versions.at(-1);
  const actions = el('div', 'row-actions');
  const create = el('button', 'btn btn-outline btn-sm', '创建新版本');
  create.type = 'button';
  create.addEventListener('click', () => openVersionEditor(strategy, latest, setStatus, refresh));
  actions.append(create);
  if (latest !== undefined && latest.publishedAt === undefined) {
    const validate = el('button', 'btn btn-outline btn-sm', '静态校验');
    validate.type = 'button';
    validate.addEventListener('click', async () => {
      validate.disabled = true;
      const checked = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/validate`, {
        versionId: latest.id,
      });
      validate.disabled = false;
      responseCache.clear();
      setStatus(checked.ok ? '版本校验完成' : errorText(checked), !checked.ok);
      if (checked.ok) await refresh();
    });
    actions.append(validate);
    if (latest.validationStatus === 'valid') {
      const publish = el('button', 'btn btn-primary btn-sm', '发布版本');
      publish.type = 'button';
      publish.addEventListener('click', async () => {
        const confirmed = await confirmDialog({
          title: '发布策略版本',
          message: `确认发布 v${latest.version} 并将其设为当前有效版本？`,
          confirmLabel: '发布',
        });
        if (!confirmed) return;
        publish.disabled = true;
        const published = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/publish`, {
          versionId: latest.id,
        });
        publish.disabled = false;
        responseCache.clear();
        setStatus(published.ok ? '策略版本已发布' : errorText(published), !published.ok);
        if (published.ok) await refresh();
      });
      actions.append(publish);
    }
  }
  if (strategy.status === 'active' || strategy.status === 'paused') {
    const next = strategy.status === 'active' ? 'pause' : 'resume';
    const toggle = el(
      'button',
      'btn btn-outline btn-sm',
      next === 'pause' ? '暂停策略' : '恢复策略',
    );
    toggle.type = 'button';
    toggle.addEventListener('click', async () => {
      const changed = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/${next}`, {});
      responseCache.clear();
      setStatus(
        changed.ok ? (next === 'pause' ? '策略已暂停' : '策略已恢复') : errorText(changed),
        !changed.ok,
      );
      if (changed.ok) await refresh();
    });
    actions.append(toggle);
  }
  const versionRows = versions.map((version) =>
    el('article', 'entity-item strategy-version-item', [
      el('div', 'flex gap-2', [
        el('strong', null, `v${version.version}`),
        badge(
          version.validationStatus === 'valid'
            ? ['有效', 'badge-active']
            : version.validationStatus === 'invalid'
              ? ['无效', 'badge-pos']
              : ['待校验', 'badge-neutral'],
          version.validationStatus,
        ),
        ...(version.publishedAt ? [el('span', 'badge badge-active', '已发布')] : []),
      ]),
      el('span', 'mono muted', version.definitionHash),
      el('p', null, version.changeSummary ?? '无变更说明'),
      ...(version.validationErrors ?? []).map((message) => el('p', 'status error', message)),
      el('details', null, [
        el('summary', null, '查看 definition JSON'),
        el('pre', 'strategy-definition-json', JSON.stringify(version.definition, null, 2)),
      ]),
    ]),
  );
  return el('div', null, [
    el('div', 'strategy-tab-heading', [el('h3', null, '版本与运行设置'), actions]),
    ...(versionRows.length === 0
      ? [el('p', 'placeholder', '尚无版本，请创建第一个版本草案。')]
      : versionRows),
    el('section', 'strategy-empty-state compact', [
      el('strong', null, '调度尚未启用'),
      el(
        'p',
        'muted',
        '调度属于独立 StrategySchedule；在 Phase B 实现前不展示不可生效的 cron 设置。',
      ),
    ]),
  ]);
};

const renderTabContent = async (workspace, state, setStatus, refresh) => {
  if (state.tab === 'overview') return renderOverview(workspace, state);
  if (state.tab === 'pool') return renderPool(workspace.strategy.id, setStatus);
  if (state.tab === 'candidates') {
    return renderCandidates(workspace.strategy.id, state, setStatus);
  }
  if (state.tab === 'runs') return renderRuns(workspace.strategy.id);
  if (state.tab === 'insights') return renderInsights();
  return renderSettings(workspace.strategy.id, setStatus, refresh);
};

const runAction = async (strategy, persist, setStatus, refresh) => {
  let stockIds;
  if (!persist) {
    const values = await promptDialog({
      title: '样本试跑',
      fields: [{ key: 'stockId', label: '样本股票代码', value: '600519.SH' }],
      confirmLabel: '试跑',
      note: '试跑读取外部行情，但不落库、不替换当前股票池。',
    });
    if (values === null || values.stockId.length === 0) return;
    stockIds = [values.stockId];
  } else {
    const confirmed = await confirmDialog({
      title: '正式运行',
      message: '将执行全市场扫描并原子落库；失败或部分运行不会覆盖上一份有效股票池。',
      confirmLabel: '开始运行',
    });
    if (!confirmed) return;
  }
  setStatus(persist ? '策略正式运行中…' : '策略样本试跑中…');
  const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/run`, {
    ...(stockIds === undefined ? {} : { stockIds }),
    persist,
  });
  if (!result.ok) {
    setStatus(errorText(result), true);
    return;
  }
  responseCache.clear();
  setStatus(
    persist
      ? `运行${RUN_STATUS[result.data.run.status]?.[0] ?? result.data.run.status}；结果 ${result.data.results.length}，信号 ${result.data.signals.length}`
      : `试跑${RUN_STATUS[result.data.run.status]?.[0] ?? result.data.run.status}；结果 ${result.data.results.length}（未落库）`,
  );
  await refresh();
};

const renderWorkspaceDetail = async (strategyId, state, setStatus, epoch) => {
  const root = $('#strategy-detail');
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
  const headerActions = el('div', 'row-actions');
  if (workspace.currentVersion !== undefined && workspace.strategy.status === 'active') {
    const sample = el('button', 'btn btn-outline btn-sm', '样本试跑');
    sample.type = 'button';
    sample.addEventListener(
      'click',
      () => void runAction(workspace.strategy, false, setStatus, rerender),
    );
    const formal = el('button', 'btn btn-primary btn-sm', '正式运行');
    formal.type = 'button';
    formal.addEventListener(
      'click',
      () => void runAction(workspace.strategy, true, setStatus, rerender),
    );
    headerActions.append(sample, formal);
  }
  const tabs = el('div', 'strategy-tabs');
  tabs.setAttribute('role', 'tablist');
  const tabButtons = Object.entries(TAB_LABELS).map(([key, label]) => {
    const button = el('button', state.tab === key ? 'active' : '', label);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(state.tab === key));
    button.tabIndex = state.tab === key ? 0 : -1;
    button.addEventListener('click', () => navigate(state, { tab: key }));
    tabs.append(button);
    return button;
  });
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
          ]),
          el('p', 'muted', workspace.strategy.description),
          el(
            'div',
            'strategy-workspace-meta',
            workspace.currentRun
              ? `数据截止 ${fmtDateTime(workspace.currentRun.dataAsOf)} · 完整运行 ${fmtDateTime(workspace.currentRun.finishedAt ?? workspace.currentRun.startedAt)}`
              : '尚无完整运行',
          ),
        ]),
        headerActions,
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
  const list = $('#strategies-list');
  const detail = $('#strategy-detail');
  if (list === null || detail === null) return;
  const state = parseStrategyHash(window.location.hash);
  if (state.strategyId.length === 0 && preferredStrategyId.length > 0) {
    window.location.hash = buildStrategyHash({
      ...state,
      strategyId: preferredStrategyId,
      tab: 'settings',
    });
    return;
  }
  const result = await cachedGet('/api/strategies');
  if (epoch !== requestEpoch) return;
  if (!result.ok) {
    mount(list, el('p', 'status error', errorText(result)));
    return;
  }
  const strategies = result.data.strategies ?? [];
  const meta = $('#strategies-meta');
  if (meta !== null) meta.textContent = `${strategies.length} 个`;
  mount(
    list,
    strategies.length === 0
      ? el('div', 'strategy-empty-state compact', [
          el('strong', null, '尚无策略'),
          el('p', 'muted', '从右上角新增策略或复制内置模板。'),
        ])
      : strategies.map((strategy) => {
          const row = el('button', 'entity-row', [
            el('span', 'entity-row-main', [
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
