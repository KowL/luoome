import { callApi } from './api.js';
import { changeClass } from './market-shared.js';
import { closeModal, confirmDialog, openModal, promptDialog } from './modal.js';
import { stockIdentityLink } from './stock-link.js';
import {
  $,
  createPagination,
  el,
  fmtDateTime,
  fmtNum,
  fmtSigned,
  mount,
  sortableHeader,
} from './ui.js';

const STRATEGY_TABS = new Set(['overview', 'pool', 'runs', 'insights', 'cycle', 'settings']);

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

const TAB_LABELS = {
  overview: '概览',
  pool: '股票池',
  runs: '执行记录',
  insights: 'AI 洞察',
  cycle: '闭环',
  settings: '设置',
};
const STRATEGY_STATUS = {
  active: ['运行中', 'badge-active'],
  draft: ['草稿', 'badge-draft'],
  paused: ['已暂停', 'badge-paused'],
  archived: ['已归档', 'badge-neutral'],
};
const RUN_STATUS = {
  complete: ['已完成', 'badge-active'],
  partial: ['已完成（历史）', 'badge-important'],
  failed: ['失败', 'badge-pos'],
  running: ['运行中', 'badge-neutral'],
};
const RUN_SCOPE = {
  operational: ['生产', 'badge-active'],
  evaluation: ['历史评估', 'badge-neutral'],
};
const PUBLICATION_STATUS = {
  published: ['已发布', 'badge-active'],
  withheld: ['暂不发布', 'badge-important'],
  'non-publishing': ['不进入当前', 'badge-neutral'],
};
const DATA_HEALTH = {
  complete: '完整',
  partial: '部分可用',
  unavailable: '不可用',
};
const RULE_STATUS = {
  matched: ['命中', 'badge-active'],
  'not-matched': ['未命中', 'badge-neutral'],
  unknown: ['数据缺失', 'badge-important'],
  error: ['求值错误', 'badge-pos'],
};
const RESULT_VIEW_STATUS = {
  selected: ['入选', 'badge-active'],
  incomplete: ['数据不完整', 'badge-important'],
  excluded: ['未入选', 'badge-neutral'],
};

let requestEpoch = 0;
const responseCache = new Map();

export const invalidateStrategyWorkspaceCache = () => responseCache.clear();

const errorText = (result) => {
  const error = result?.error;
  if (error === undefined) return '请求失败';
  if (error.message) return error.message;
  if (error.cause) return error.cause;
  if (error.entity) return `${error.entity}不存在`;
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
  const warnings = [...(workspace.warnings ?? [])];
  const latest = workspace.latestAttempt;
  if (latest?.publication?.status && latest.publication.status !== 'published') {
    warnings.unshift(
      `最近尝试：${PUBLICATION_STATUS[latest.publication.status]?.[0] ?? latest.publication.status} · ${latest.publication.reasons?.join('、') || '无发布原因'}`,
    );
  }
  if (workspace.overview.health === 'partial') {
    warnings.unshift('本次运行已完成；部分标的数据不可用，股票池仅展示已明确命中的标的。');
  }
  if (warnings.length === 0) return null;
  return el(
    'div',
    `strategy-health-banner ${workspace.overview.health === 'failed' ? 'danger' : 'warning'}`,
    warnings.map((warning) => el('p', null, warning)),
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
  for (const [index, evaluation] of evaluations.entries()) {
    const status = RULE_STATUS[evaluation.status];
    const isV2 = evaluation.schemaVersion === 2;
    panel.append(
      el('article', 'strategy-rule-item', [
        el('div', 'flex gap-2', [
          el('strong', null, `规则 ${index + 1}`),
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
  if (view.kind === 'rule-near-miss') {
    return `未满足 ${view.blockingRuleIds.length} 条选股规则`;
  }
  if (view.kind === 'ranking-near-miss') {
    return `距 Top ${view.distance?.positionsAway ?? '--'} 位`;
  }
  if (view.kind === 'incomplete') return '数据或解释不完整';
  return view.result.selected ? '已入选' : '未入选';
};

const renderResultTable = (payload, setStatus, sortState, onSort) => {
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
    detailCell.colSpan = 9;
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
    const quote = row.quote;
    const changePct = quote?.changePct;
    body.append(
      el('tr', null, [
        el('td', null, stockIdentityLink(row.stock)),
        el('td', 'num mono', typeof quote?.price === 'number' ? fmtNum(quote.price, 2) : '--'),
        el(
          'td',
          `num mono ${changeClass(changePct)}`,
          typeof changePct === 'number' ? `${fmtSigned(changePct)}%` : '--',
        ),
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
          sortableHeader('价格', 'price', sortState, onSort),
          sortableHeader('涨幅', 'change-pct', sortState, onSort),
          sortableHeader('排名', 'rank', sortState, onSort),
          sortableHeader('规则分', 'score', sortState, onSort),
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
      el('span', 'section-kicker', 'NO USABLE RUN'),
      el('h3', null, '尚无可用运行'),
      el('p', null, '发布有效版本后可进行样本试跑或正式运行。试跑不会成为当前股票池。'),
      settings,
    ]);
  }
  const grid = el('div', 'strategy-summary-grid', [
    metric('当前股票', overview.selectedCount),
    metric(
      '新增 / 退出',
      overview.enteredCount === undefined
        ? '--'
        : `${overview.enteredCount} / ${overview.exitedCount}`,
    ),
    metric(
      '当前发布',
      PUBLICATION_STATUS[current.publication?.status]?.[0] ?? 'legacy/unknown',
      current.scope === 'evaluation' ? '历史评估不会进入 operational current' : '',
    ),
  ]);
  const providers = (current.providerStatuses ?? []).map((provider) =>
    el('span', `badge ${provider.ok ? 'badge-active' : 'badge-important'}`, provider.provider),
  );

  return el('div', null, [
    grid,
    el('section', 'strategy-overview-audit', [
      el('div', null, [
        el('span', 'strategy-metric-label', '当前完成运行'),
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
      el('div', null, [
        el('span', 'strategy-metric-label', '验收 / 覆盖'),
        el(
          'strong',
          'mono',
          current.summary?.schemaVersion === 4
            ? `${Math.round(current.summary.acceptance.metrics.evaluatedRatio * 100)}% · 失败 ${Math.round(current.summary.acceptance.metrics.failedRatio * 100)}%`
            : '历史运行未保存 V4 验收',
        ),
      ]),
    ]),
  ]);
};

const DEFAULT_POOL_PAGE_SIZE = 30;

const renderPool = async (strategyId, setStatus) => {
  const search = el('input');
  search.type = 'search';
  search.placeholder = '搜索代码或名称';
  const searchBtn = el('button', 'btn btn-primary btn-sm', '搜索');
  searchBtn.type = 'button';
  const count = el('span', 'entity-count', '--');
  const list = el('div', 'strategy-pool-list');
  let query = '';
  let epoch = 0;
  let render;
  let sortState = { key: 'rank', order: 'asc' };
  const onSort = (key) => {
    sortState = {
      key,
      order: sortState.key === key && sortState.order === 'asc' ? 'desc' : 'asc',
    };
    pager.setState({ page: 1 });
    void render();
  };
  const pager = createPagination({
    pageSize: DEFAULT_POOL_PAGE_SIZE,
    onChange: () => {
      if (render !== undefined) void render();
    },
  });
  render = async () => {
    const current = ++epoch;
    const { page, pageSize } = pager.getState();
    const params = new URLSearchParams({
      view: 'selected',
      sort: sortState.key,
      order: sortState.order,
      offset: String((page - 1) * pageSize),
      limit: String(pageSize),
    });
    if (query.length > 0) params.set('query', query);
    const result = await cachedGet(
      `/api/strategies/${encodeURIComponent(strategyId)}/results?${params.toString()}`,
    );
    if (epoch !== current) return;
    if (!result.ok) {
      mount(list, el('p', 'status error', errorText(result)));
      return;
    }
    count.textContent = `${result.data.total} 只`;
    pager.setState({ total: result.data.total });
    pager.root.hidden = result.data.total === 0;
    mount(list, renderResultTable(result.data, setStatus, sortState, onSort));
  };
  const doSearch = () => {
    query = search.value.trim();
    pager.setState({ page: 1 });
    void render();
  };
  searchBtn.addEventListener('click', doSearch);
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    doSearch();
  });
  const root = el('div', null, [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('h3', null, '当前股票池'),
        el('p', 'muted', '来自最近一次持久化可用运行'),
      ]),
      el('div', 'row-actions', [search, searchBtn, count]),
    ]),
    list,
    pager.root,
  ]);
  await render();
  return root;
};

const runSummaryText = (run) => {
  const summary = run.summary ?? {};
  if (summary.schemaVersion === 4 || summary.schemaVersion === 3) {
    return `数据 ${DATA_HEALTH[summary.dataHealth] ?? summary.dataHealth} · 覆盖 ${summary.universeCount} · 求值 ${summary.evaluatedCount} · 入选 ${summary.selectedCount} · 信号 ${summary.signalCount} · 不完整 ${summary.incompleteCount} · 失败 ${summary.failedCount}`;
  }
  if (summary.schemaVersion === 2) {
    return `覆盖 ${summary.universeCount} · 求值 ${summary.evaluatedCount} · 入选 ${summary.selectedCount} · 信号 ${summary.signalCount} · 不完整 ${summary.partialCount} · 失败 ${summary.failedCount}`;
  }
  return '历史运行摘要不完整';
};

/**
 * 运行详情弹窗内容：StrategySignal 信号列表。
 * @param {object} data GET /api/strategy-runs/:id 的 data
 * @returns {HTMLElement} 可直接放入弹窗 body 的节点
 */
const signalRow = (identity) => (signal) =>
  el('div', 'entity-item', [
    stockIdentityLink(identity(signal.stockId)),
    el('span', 'mono', `${signal.direction} · score ${fmtNum(signal.score)}`),
    el('p', 'muted', (signal.evidence ?? []).join('；')),
  ]);

export const buildRunDetailContent = (data) => {
  const identityById = new Map((data.stocks ?? []).map((stock) => [stock.stockId, stock]));
  const identity = (stockId) =>
    identityById.get(stockId) ?? { stockId, stockName: '名称暂缺', nameStatus: 'unavailable' };
  const signals = data.signals ?? [];
  const listContainer = el('div', 'paginated-list');
  function renderPage() {
    const { page, pageSize } = pagination.getState();
    mount(
      listContainer,
      signals.slice((page - 1) * pageSize, page * pageSize).map(signalRow(identity)),
    );
  }
  const pagination = createPagination({ total: signals.length, onChange: renderPage });
  renderPage();
  return el('div', 'strategy-run-detail', [
    el('p', 'muted', `信号 ${signals.length}`),
    el('h4', null, 'StrategySignal'),
    ...(signals.length === 0
      ? [el('p', 'placeholder', '无信号')]
      : [listContainer, pagination.root]),
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
  if (!result.ok) return el('p', 'placeholder', '至少需要两次可用运行后才能比较。');
  const { diff, warnings } = result.data;
  const strip = el('div', 'strategy-diff-strip', [
    metric('新增', diff.summary.entered),
    metric('退出', diff.summary.exited),
    metric('候选转正', diff.summary.candidatePromoted),
    metric('排名变化', diff.summary.rankChanged),
    metric('数据待确认', diff.summary.dataUnavailable ?? 0),
  ]);
  const rows = diff.rows.filter((row) => !row.changes.includes('stayed') || row.changes.length > 1);
  const table =
    rows.length === 0
      ? el('p', 'placeholder', '两次可用运行没有实质变化。')
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
    el('div', 'strategy-tab-heading', [el('h3', null, '最近两次可用运行对比')]),
    ...(warnings ?? []).map((warning) => el('p', 'status warning', warning)),
    strip,
    table,
  ]);
};

const rerunFailedItems = async (strategyId, runId, button) => {
  button.disabled = true;
  button.textContent = '重跑中…';
  const result = await post(`/api/strategies/${encodeURIComponent(strategyId)}/run`, {
    persist: true,
    retryRunId: runId,
  });
  if (!result.ok) {
    button.disabled = false;
    button.textContent = '仅重跑失败项';
    return result;
  }
  responseCache.clear();
  const item = result.data?.item ?? result.data?.cycle?.items?.[0];
  button.textContent =
    item?.status === 'complete'
      ? '重跑完成'
      : item?.status === 'partial'
        ? '重跑部分完成'
        : '重跑结束';
  return result;
};

const runRow = (run, onRetry) => {
  const view = el('button', 'btn btn-outline btn-sm', '查看');
  view.type = 'button';
  view.addEventListener('click', () => void openRunDetail(run.id));
  const actions = [view];
  const summary = run.summary ?? {};
  if (
    run.scope === 'operational' &&
    run.publication?.status === 'withheld' &&
    (summary.schemaVersion === 4 || summary.schemaVersion === 3) &&
    summary.failedCount > 0
  ) {
    const retry = el('button', 'btn btn-outline btn-sm', '仅重跑失败项');
    retry.type = 'button';
    retry.addEventListener('click', () => void onRetry(run.id, retry));
    actions.push(retry);
  }
  return el('tr', null, [
    el('td', 'mono', fmtDateTime(run.startedAt)),
    el('td', null, run.mode),
    el('td', null, badge(RUN_SCOPE[run.scope] ?? null, run.scope ?? 'legacy')),
    el(
      'td',
      null,
      badge(
        PUBLICATION_STATUS[run.publication?.status] ?? null,
        run.publication?.status ?? 'legacy/unknown',
      ),
    ),
    el('td', null, badge(RUN_STATUS[run.status], run.status)),
    el('td', 'muted', runSummaryText(run)),
    el('td', null, el('div', 'row-actions', actions)),
  ]);
};

export const renderRuns = async (strategyId, scope = 'operational') => {
  const runsPath = `/api/strategies/${encodeURIComponent(strategyId)}/runs?scope=${encodeURIComponent(scope)}`;
  const result = await cachedGet(runsPath);
  if (!result.ok) return el('p', 'status error', errorText(result));
  let runs = result.data.runs ?? [];
  const tbody = el('tbody');
  function renderPage() {
    const { page, pageSize } = pagination.getState();
    mount(
      tbody,
      runs.slice((page - 1) * pageSize, page * pageSize).map((run) => runRow(run, retryRun)),
    );
  }
  const pagination = createPagination({ total: runs.length, onChange: renderPage });
  const refreshRuns = async () => {
    responseCache.delete(runsPath);
    const refreshed = await cachedGet(runsPath);
    if (!refreshed.ok) return refreshed;
    runs = refreshed.data.runs ?? [];
    pagination.setState({ total: runs.length });
    renderPage();
    return refreshed;
  };
  const retryRun = async (runId, button) => {
    const retried = await rerunFailedItems(strategyId, runId, button);
    if (retried.ok) await refreshRuns();
  };
  renderPage();
  const tableWrap = el('div', 'table-wrap strategy-run-timeline', [
    el('table', 'table', [
      el(
        'thead',
        null,
        el('tr', null, [
          el('th', null, '时间'),
          el('th', null, '模式'),
          el('th', null, '范围'),
          el('th', null, '发布'),
          el('th', null, '状态'),
          el('th', null, '摘要'),
          el('th', null, '操作'),
        ]),
      ),
      tbody,
    ]),
  ]);
  return el('div', null, [
    tableWrap,
    pagination.root,
    ...(scope === 'operational'
      ? [await renderDiff(strategyId)]
      : [el('p', 'muted', '历史评估结果与生产 current 隔离；请选择具体运行后再做显式对比。')]),
  ]);
};

const pct = (value) => (value === undefined ? '--' : `${fmtNum(value * 100, 2)}%`);

const CYCLE_STATUS = {
  complete: ['完整', 'badge-active'],
  pending: ['待观察', 'badge-important'],
  unavailable: ['不可用', 'badge-pos'],
};

const cycleLink = (href, label, className = 'btn btn-outline btn-sm') => {
  const link = el('a', className, label);
  link.href = href;
  return link;
};

const observationFactText = (observation) => {
  const values = [
    `收益 ${pct(observation.returnPct)}`,
    `MFE ${pct(observation.maxFavorableExcursionPct)}`,
    `MAE ${pct(observation.maxAdverseExcursionPct)}`,
    `基准 ${observation.benchmarkStatus === 'complete' ? pct(observation.benchmarkReturnPct) : '不可用'}`,
  ];
  return values.join(' · ');
};

const adviceValidityText = (advice) =>
  new Date(advice.validUntil).getTime() < Date.now() ? '已过期' : '有效';

const renderCycleCard = (cycle, strategyId) => {
  const stock = stockIdentityLink({
    stockId: cycle.stockId,
    stockName: cycle.stockId,
    nameStatus: 'unavailable',
  });
  const progress = cycle.observationProgress ?? [];
  const observationsById = new Map((cycle.observations ?? []).map((row) => [row.id, row]));
  const adviceRows = cycle.advices ?? [];
  const tradeRows = cycle.trades ?? [];
  const tradeLinks = cycle.tradeLinks ?? [];
  const insightHref = buildStrategyHash({
    strategyId,
    tab: 'insights',
    scope: 'operational',
    runId: cycle.runId,
  });
  const timeline = el('ol', 'strategy-cycle-timeline', [
    el('li', 'strategy-cycle-stage strategy-cycle-fact', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', '事实 / 入选结果'),
        el(
          'span',
          'mono muted',
          `score ${cycle.result.score ?? '--'} · rank ${cycle.result.rank ?? '--'}`,
        ),
      ]),
      el('p', null, 'StrategyResult 已明确入选；以下事实均绑定本次 run。'),
      el('p', 'muted', `已记录 ${(cycle.result.evidence ?? []).length} 项入选依据`),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-fact', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', '事实 / emitted StrategySignal'),
        el('span', 'mono muted', `${(cycle.signals ?? []).length} 条`),
      ]),
      ...((cycle.signals ?? []).length === 0
        ? [el('p', 'placeholder', '本周期没有 emitted signal。')]
        : (cycle.signals ?? []).map((signal) =>
            el('article', 'strategy-cycle-fact-row', [
              el('strong', null, `${signal.direction} · score ${fmtNum(signal.score)}`),
              el('p', 'muted', (signal.evidence ?? []).join('；')),
            ]),
          )),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-fact', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', '事实 / 事后观察'),
        el('span', 'muted', '不是回测'),
      ]),
      el(
        'div',
        'strategy-cycle-horizons',
        ['t1', 't3', 't5', 't20'].map((horizon) => {
          const item = progress.find((row) => row.horizon === horizon) ?? {
            horizon,
            status: 'unavailable',
            observationIds: [],
            completeCount: 0,
            pendingCount: 0,
            unavailableCount: 0,
            benchmarkStatus: 'unavailable',
            unavailableReasons: ['尚无观察记录'],
          };
          const facts = (item.observationIds ?? [])
            .map((id) => observationsById.get(id))
            .filter(Boolean);
          return el('article', 'strategy-cycle-horizon', [
            el('div', 'strategy-cycle-stage-head', [
              el('strong', null, horizon.toUpperCase()),
              badge(CYCLE_STATUS[item.status], item.status),
            ]),
            el(
              'p',
              'mono muted',
              `完整 ${item.completeCount ?? 0} · 待观察 ${item.pendingCount ?? 0} · 不可用 ${item.unavailableCount ?? 0}`,
            ),
            ...(facts.length === 0
              ? [el('p', 'muted', item.unavailableReasons?.join('；') || '事实不可用')]
              : facts.map((observation) => el('p', 'muted', observationFactText(observation)))),
            el(
              'small',
              'muted',
              `benchmark ${item.benchmarkStatus === 'complete' ? '可用' : '不可用'} · due ${fmtDateTime(item.dueAt)}`,
            ),
          ]);
        }),
      ),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-ai', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', 'AI 洞察 / 解释'),
        cycleLink(insightHref, '查看事实与 AI 洞察'),
      ]),
      el('p', null, 'AI 洞察只解释已核验事实并保留证据引用；此处不把解释改写成买卖建议。'),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-advice', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', 'AI Advice / 决策快照'),
        cycleLink(`#advice?stockId=${encodeURIComponent(cycle.stockId)}`, '打开 Advice 页面'),
      ]),
      ...(adviceRows.length === 0
        ? [
            el(
              'p',
              'placeholder',
              '本周期没有 Advice；自动生成需要用户显式启用推荐策略且满足生产运行门禁。',
            ),
          ]
        : adviceRows.map((advice) => {
            const trigger = advice.basedOn?.strategy?.recommendationTrigger ?? '--';
            const outcome = advice.outcome;
            const outcomeSummary =
              outcome === undefined
                ? '结果待回填'
                : [
                    `结果 ${outcome.outcome}`,
                    ...(outcome.pnl === undefined ? [] : [`PnL ${fmtSigned(outcome.pnl)}`]),
                    ...(outcome.benchmarkPnl === undefined
                      ? []
                      : [`基准 ${fmtSigned(outcome.benchmarkPnl)}`]),
                  ].join(' · ');
            return el('article', 'strategy-cycle-advice-row', [
              el('div', 'strategy-cycle-stage-head', [
                el('strong', null, `${advice.decision} · confidence ${advice.confidence}/100`),
                el('span', 'badge badge-neutral', `阶段 ${trigger}`),
              ]),
              el('p', null, advice.reasoning?.premise ?? '无 Advice premise'),
              el(
                'p',
                'muted',
                `${adviceValidityText(advice)} ${fmtDateTime(advice.validFrom)} → ${fmtDateTime(advice.validUntil)} · ${outcomeSummary}`,
              ),
              ...(outcome?.tradeIds?.length
                ? [el('p', 'muted', `已关联 ${outcome.tradeIds.length} 笔交易`)]
                : []),
              cycleLink(`#advice?stockId=${encodeURIComponent(cycle.stockId)}`, '查看这条 Advice'),
            ]);
          })),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-trade', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', '用户行动 / 显式 Trade'),
        cycleLink('#review', '打开全局复盘'),
      ]),
      ...(tradeRows.length === 0
        ? [el('p', 'placeholder', '当前账户没有明确关联到本建议的交易。')]
        : tradeRows.map((trade) => {
            const links = tradeLinks.filter((link) => link.tradeId === trade.id);
            return el('article', 'strategy-cycle-trade-row', [
              el('strong', null, `${trade.side} · ${trade.quantity} @ ${trade.price}`),
              el('span', 'muted', fmtDateTime(trade.executedAt)),
              ...(links.length > 0 ? [el('small', 'muted', '明确关联到建议')] : []),
            ]);
          })),
      ...(tradeRows.length > 0 ? [el('p', 'muted', `已关联 ${tradeRows.length} 笔交易`)] : []),
    ]),
  ]);
  const audit = el('details', 'strategy-cycle-audit', [
    el('summary', null, '证据、未知项与限制'),
    el(
      'p',
      'mono muted',
      `事实截止 ${fmtDateTime(cycle.factsAsOf)} · ${cycle.evidenceIds?.length ?? 0} 项依据`,
    ),
    ...(cycle.unknowns?.length
      ? [el('p', 'status warning', `待确认：${cycle.unknowns.join('；')}`)]
      : []),
    ...(cycle.limitations?.length
      ? [el('p', 'muted', `限制：${cycle.limitations.join('；')}`)]
      : []),
  ]);
  return el('article', 'strategy-cycle-card', [
    el('header', 'strategy-cycle-head', [
      el('div', null, [stock, el('p', 'muted', '本次正式运行入选')]),
      el('div', 'strategy-cycle-run-meta', [
        badge(RUN_STATUS[cycle.run?.status], cycle.run?.status ?? '--'),
        badge(
          PUBLICATION_STATUS[cycle.run?.publication?.status],
          cycle.run?.publication?.status ?? '--',
        ),
        el('span', 'mono muted', `数据截止 ${fmtDateTime(cycle.run?.dataAsOf)}`),
      ]),
    ]),
    timeline,
    audit,
  ]);
};

export const renderDecisionCycles = async (strategyId, state = {}) => {
  const params = new URLSearchParams({ limit: '50' });
  if (state.runId) params.set('runId', state.runId);
  if (state.stockId) params.set('stockId', state.stockId);
  const result = await cachedGet(
    `/api/strategies/${encodeURIComponent(strategyId)}/decision-cycles?${params.toString()}`,
  );
  if (!result.ok) return el('p', 'status error', errorText(result));
  const payload = result.data;
  const cycles = payload.cycles ?? [];
  const header = el('div', 'strategy-tab-heading', [
    el('div', null, [
      el('span', 'section-kicker', 'DECISION CYCLE'),
      el('h3', null, '策略候选闭环'),
      el('p', 'muted', '按每次正式运行与候选股票形成闭环；观察是事后事实，Advice 是可选决策快照。'),
    ]),
    cycleLink('#review', '全局复盘'),
  ]);
  if (cycles.length === 0) {
    return el('div', 'strategy-cycle-grid', [
      header,
      el('div', 'strategy-empty-state', [
        el('strong', null, '暂无可展示的生产候选周期'),
        el(
          'p',
          'muted',
          '仅 published operational run 的 selected StrategyResult 进入闭环；replay、evaluation、withheld 和未发布运行会被排除。',
        ),
        ...(payload.unknowns?.length
          ? [el('p', 'status warning', payload.unknowns.join('；'))]
          : []),
      ]),
    ]);
  }
  return el('div', 'strategy-cycle-grid', [
    header,
    el(
      'p',
      'mono muted',
      `共 ${payload.total} 个周期 · 事实截止 ${fmtDateTime(payload.factsAsOf)} · ${payload.evidenceIds?.length ?? 0} 项依据`,
    ),
    ...cycles.map((cycle) => renderCycleCard(cycle, strategyId)),
    ...(payload.limitations?.length
      ? [
          el(
            'div',
            'strategy-health-banner warning',
            payload.limitations.map((item) => el('p', null, item)),
          ),
        ]
      : []),
  ]);
};

const renderInsightNarrative = (insight) =>
  el('section', 'strategy-insight-narrative', [
    el('span', 'section-kicker', 'AI EXPLANATION'),
    el('h3', null, insight.headline),
    el('p', null, insight.summary),
    ...(insight.findings ?? []).map((finding) =>
      el('article', 'strategy-insight-finding', [
        el('div', 'flex gap-2', [
          el('strong', null, finding.title),
          badge(
            finding.kind === 'risk'
              ? ['风险', 'badge-important']
              : finding.kind === 'limitation'
                ? ['限制', 'badge-neutral']
                : ['趋势', 'badge-active'],
            finding.kind,
          ),
        ]),
        el('p', null, finding.detail),
        el('small', 'muted', `已引用 ${finding.factRefs.length} 项已核验事实`),
      ]),
    ),
    ...(insight.risks?.length
      ? [el('p', 'status warning', `风险：${insight.risks.join('；')}`)]
      : []),
    el('p', 'muted', insight.disclaimer),
  ]);

export const renderInsights = async (
  strategyId,
  setStatus = () => {},
  scope = 'operational',
  state = parseStrategyHash(typeof window === 'undefined' ? '' : window.location.hash),
) => {
  const path = `/api/strategies/${encodeURIComponent(strategyId)}/insights?scope=${encodeURIComponent(scope)}`;
  const result = await cachedGet(path);
  if (!result.ok) return el('p', 'status error', errorText(result));
  const facts = result.data;
  const output = el('div', 'strategy-insight-output');
  const generate = el('button', 'btn btn-primary btn-sm', '生成 AI 解读');
  generate.type = 'button';
  generate.addEventListener('click', async () => {
    generate.disabled = true;
    setStatus('正在基于已核验事实生成解读…');
    const generated = await post(
      `/api/strategies/${encodeURIComponent(strategyId)}/insights/generate`,
      { windowDays: facts.window.days, scope },
    );
    generate.disabled = false;
    if (!generated.ok) {
      setStatus(errorText(generated), true);
      return;
    }
    output.replaceChildren(renderInsightNarrative(generated.data.insight));
    setStatus(`AI 解读已生成 · ${generated.data.provider}`);
  });
  const observationRows = facts.observations.map((item) =>
    el('tr', null, [
      el('td', 'mono', item.horizon.toUpperCase()),
      el('td', null, `${item.complete}/${item.total}`),
      el('td', null, item.uniqueStocks ?? '--'),
      el('td', null, pct(item.averageReturnPct)),
      el('td', null, pct(item.medianReturnPct)),
      el('td', null, pct(item.p25ReturnPct)),
      el('td', null, pct(item.p75ReturnPct)),
      el('td', null, pct(item.averageExcessReturnPct)),
      el('td', null, pct(item.averageMaxFavorableExcursionPct)),
      el('td', null, pct(item.averageMaxAdverseExcursionPct)),
      el('td', null, item.total === 0 ? '--' : pct(item.missingRate)),
      el('td', null, item.benchmarkStatus === 'complete' ? '可用' : '不可用'),
      el('td', null, item.observedAsOf ? fmtDateTime(item.observedAsOf) : '--'),
    ]),
  );
  const groupedRows = (facts.groupedObservations ?? [])
    .slice(0, 36)
    .map((item) =>
      el('tr', null, [
        el('td', null, item.dimension),
        el('td', null, item.group),
        el('td', 'mono', item.horizon.toUpperCase()),
        el('td', null, `${item.complete}/${item.total}`),
        el('td', null, item.uniqueStocks ?? '--'),
        el('td', null, pct(item.averageReturnPct)),
        el('td', null, pct(item.medianReturnPct)),
        el('td', null, pct(item.p25ReturnPct)),
        el('td', null, pct(item.p75ReturnPct)),
        el('td', null, pct(item.averageMaxFavorableExcursionPct)),
        el('td', null, pct(item.averageMaxAdverseExcursionPct)),
        el('td', null, item.total === 0 ? '--' : pct(item.missingRate)),
        el('td', null, item.benchmarkStatus === 'complete' ? '可用' : '不可用'),
        el('td', null, item.observedAsOf ? fmtDateTime(item.observedAsOf) : '--'),
      ]),
    );
  return el('div', 'strategy-insight-grid', [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('span', 'section-kicker', 'FACT-BASED INSIGHTS'),
        el('h3', null, '策略事实与真实表现'),
        el(
          'p',
          'muted',
          `范围：${facts.scope === 'evaluation' ? '历史评估' : '生产'} · 近 ${facts.window.days} 天 · 事实截止 ${fmtDateTime(facts.factsAsOf)} · 观察截止 ${facts.observationAsOf ? fmtDateTime(facts.observationAsOf) : '暂无'}`,
        ),
      ]),
      el('div', 'row-actions', [
        ...['operational', 'evaluation'].map((candidate) => {
          const button = el(
            'button',
            `btn btn-outline btn-sm${candidate === scope ? ' active' : ''}`,
            candidate === 'evaluation' ? '历史评估' : '生产事实',
          );
          button.type = 'button';
          button.addEventListener('click', () => {
            window.location.hash = buildStrategyHash({ ...state, scope: candidate });
          });
          return button;
        }),
        generate,
      ]),
    ]),
    el('div', 'strategy-summary-grid', [
      metric('运行次数', facts.runs.total, `可用 ${facts.runs.usable} · 失败 ${facts.runs.failed}`),
      metric('当前明确命中', facts.currentSelection.selectedCount),
      metric(
        '平均评分',
        facts.currentSelection.averageScore === undefined
          ? '--'
          : fmtNum(facts.currentSelection.averageScore, 2),
      ),
      metric('关联预警', facts.alertPlans.length),
    ]),
    el('section', 'strategy-insight-section', [
      el('h4', null, '真实信号观察'),
      el(
        'p',
        'muted',
        '样本口径：同一股票、同一基准交易日、同一观察周期只保留一个可追溯事实；缺失 benchmark 保持不可用，不回填为 0。',
      ),
      el('div', 'table-wrap', [
        el('table', 'table', [
          el(
            'thead',
            null,
            el(
              'tr',
              null,
              [
                '周期',
                '完整样本',
                '唯一股票',
                '平均收益',
                '中位收益',
                'P25',
                'P75',
                '平均超额',
                '平均最大有利',
                '平均最大不利',
                '缺失率',
                '基准',
                '观察截止',
              ].map((label) => el('th', null, label)),
            ),
          ),
          el('tbody', null, observationRows),
        ]),
      ]),
      el('p', 'muted', '事后事实观察不是回测；未包含成交、费用、滑点和可交易性假设。'),
    ]),
    ...(groupedRows.length === 0
      ? []
      : [
          el('section', 'strategy-insight-section', [
            el('h4', null, '去相关分组统计'),
            el('div', 'table-wrap', [
              el('table', 'table', [
                el(
                  'thead',
                  null,
                  el(
                    'tr',
                    null,
                    [
                      '维度',
                      '分组',
                      '周期',
                      '完整样本',
                      '唯一股票',
                      '平均收益',
                      '中位收益',
                      'P25',
                      'P75',
                      '平均最大有利',
                      '平均最大不利',
                      '缺失率',
                      '基准',
                      '观察截止',
                    ].map((label) => el('th', null, label)),
                  ),
                ),
                el('tbody', null, groupedRows),
              ]),
            ]),
          ]),
        ]),
    el('div', 'strategy-insight-columns', [
      el('section', 'strategy-insight-section', [
        el('h4', null, '高频规则阻断'),
        ...(facts.blockers.length === 0
          ? [el('p', 'placeholder', '暂无明确阻断事实。')]
          : facts.blockers.map((item) =>
              el('article', 'entity-item', [
                el('strong', null, item.ruleName),
                el('span', 'mono muted', `${item.count} 次`),
              ]),
            )),
      ]),
      el('section', 'strategy-insight-section', [
        el('h4', null, '当前行业分布'),
        ...(facts.currentSelection.industries.length === 0
          ? [el('p', 'placeholder', '当前没有明确命中标的。')]
          : facts.currentSelection.industries.map((item) =>
              el('article', 'entity-item', [
                el('strong', null, item.name),
                el('span', 'mono muted', `${item.count} 只 · ${pct(item.share)}`),
              ]),
            )),
      ]),
      el('section', 'strategy-insight-section', [
        el('h4', null, '关联 AlertPlan'),
        ...(facts.alertPlans.length === 0
          ? [el('p', 'placeholder', '尚未关联预警方案。')]
          : facts.alertPlans.map((item) =>
              el('article', 'entity-item', [
                el('strong', null, item.name),
                badge(item.enabled ? ['已启用', 'badge-active'] : ['已停用', 'badge-neutral'], ''),
                el('span', 'mono muted', `${item.ruleCount} 条策略信号规则`),
              ]),
            )),
      ]),
    ]),
    el(
      'div',
      'strategy-health-banner warning',
      facts.limitations.map((limitation) => el('p', null, limitation)),
    ),
    output,
  ]);
};

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

const renderScheduleSettings = (strategy, schedule, setStatus, refresh) => {
  const cron = el('input');
  cron.value = schedule?.cron ?? '0 18 * * 1-5';
  cron.placeholder = '0 18 * * 1-5';
  const timezone = el('input');
  timezone.value = schedule?.timezone ?? 'Asia/Shanghai';
  const enabled = el('input');
  enabled.type = 'checkbox';
  enabled.checked = schedule?.enabled ?? true;
  const recommendationEnabled = el('input');
  recommendationEnabled.type = 'checkbox';
  recommendationEnabled.checked = schedule?.recommendationPolicy?.enabled ?? false;
  const configuredHorizons = Array.isArray(schedule?.recommendationPolicy?.observationHorizons)
    ? schedule.recommendationPolicy.observationHorizons
    : ['t3', 't5', 't20'];
  const observationHorizons = ['t1', 't3', 't5', 't20'].map((horizon) => {
    const input = el('input');
    input.type = 'checkbox';
    input.value = horizon;
    input.checked = configuredHorizons.includes(horizon);
    return { horizon, input };
  });
  const minScore = el('input');
  minScore.type = 'number';
  minScore.min = '0';
  minScore.max = '100';
  minScore.value = String(schedule?.recommendationPolicy?.minScore ?? 70);
  const maxRank = el('input');
  maxRank.type = 'number';
  maxRank.min = '1';
  maxRank.max = '200';
  maxRank.value = String(schedule?.recommendationPolicy?.maxRank ?? 10);
  const maxPerRun = el('input');
  maxPerRun.type = 'number';
  maxPerRun.min = '1';
  maxPerRun.max = '20';
  maxPerRun.value = String(schedule?.recommendationPolicy?.maxPerRun ?? 3);
  const cooldownHours = el('input');
  cooldownHours.type = 'number';
  cooldownHours.min = '1';
  cooldownHours.max = '720';
  cooldownHours.value = String(schedule?.recommendationPolicy?.cooldownHours ?? 72);
  const notify = el('input');
  notify.type = 'checkbox';
  notify.checked = schedule?.recommendationPolicy?.notify ?? true;
  const channel = el('select');
  for (const [value, label] of [
    ['log', '站内日志'],
    ['feishu', '飞书'],
  ]) {
    const option = el('option', null, label);
    option.value = value;
    channel.append(option);
  }
  channel.value = schedule?.recommendationPolicy?.channel ?? 'log';
  const save = el('button', 'btn btn-primary btn-sm', '保存调度');
  save.type = 'button';
  save.disabled = strategy.status !== 'active' || strategy.currentVersionId === undefined;
  save.addEventListener('click', async () => {
    save.disabled = true;
    const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/schedule`, {
      cron: cron.value.trim(),
      timezone: timezone.value.trim(),
      enabled: enabled.checked,
      recommendationPolicy: {
        enabled: recommendationEnabled.checked,
        minScore: Number(minScore.value),
        maxRank: Number(maxRank.value),
        maxPerRun: Number(maxPerRun.value),
        cooldownHours: Number(cooldownHours.value),
        notify: notify.checked,
        channel: channel.value,
        observationHorizons: observationHorizons
          .filter(({ input }) => input.checked)
          .map(({ horizon }) => horizon),
      },
    });
    save.disabled = false;
    if (!result.ok) {
      setStatus(errorText(result), true);
      return;
    }
    responseCache.clear();
    setStatus(`调度已保存，下次运行 ${fmtDateTime(result.data.schedule.nextRunAt)}`);
    await refresh();
  });
  return el('section', 'strategy-schedule-panel', [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('h3', null, '自动调度'),
        el('p', 'muted', '标准 5 段 cron；luoome 运行时每分钟自动检查到期策略。'),
      ]),
      save,
    ]),
    el('div', 'strategy-schedule-form', [
      el('label', null, ['Cron 表达式', cron]),
      el('label', null, ['时区', timezone]),
      el('label', 'strategy-schedule-toggle', [enabled, '启用']),
      el('label', 'strategy-schedule-toggle', [recommendationEnabled, '自动生成并保存 AI Advice']),
      el('fieldset', 'strategy-recommendation-horizons', [
        el('legend', null, '生成 Advice 的阶段观察'),
        ...observationHorizons.map(({ horizon, input }) =>
          el('label', 'strategy-schedule-toggle', [input, horizon.toUpperCase()]),
        ),
      ]),
      el('label', null, ['最低评分', minScore]),
      el('label', null, ['最高排名', maxRank]),
      el('label', null, ['每轮最多推荐', maxPerRun]),
      el('label', null, ['冷却小时', cooldownHours]),
      el('label', 'strategy-schedule-toggle', [notify, '生成后发送通知（与 Advice 开关独立）']),
      el('label', null, ['通知渠道', channel]),
    ]),
    el('div', 'strategy-recommendation-notice', [
      el('strong', null, '推荐策略授权边界'),
      el('p', null, '仅对 accepted + published operational run 生效。'),
      el('p', null, '勾选的 T+n 观察完成后，系统才会再次生成并保存阶段 Advice。'),
      el('p', null, '不会自动交易；通知开关与 Advice 生成开关相互独立。'),
    ]),
    el(
      'p',
      'mono muted',
      schedule?.nextRunAt
        ? `下次计划 ${fmtDateTime(schedule.nextRunAt)}`
        : '保存后计算下次运行时间；策略暂停时调度会跳过并推进。',
    ),
    ...(save.disabled ? [el('p', 'status warning', '只有已发布且运行中的策略可以启用调度。')] : []),
  ]);
};

const renderStrategyWatchlistSubscriptions = async (strategy, setStatus, refresh) => {
  const [subscriptionsResult, watchlistsResult] = await Promise.all([
    cachedGet(`/api/strategies/${encodeURIComponent(strategy.id)}/watchlists`),
    cachedGet('/api/watchlists'),
  ]);
  if (!subscriptionsResult.ok) {
    return el('section', 'strategy-schedule-panel', [
      el('h3', null, 'Strategy → Watchlist 订阅'),
      el('p', 'status error', errorText(subscriptionsResult)),
    ]);
  }
  if (!watchlistsResult.ok) {
    return el('section', 'strategy-schedule-panel', [
      el('h3', null, 'Strategy → Watchlist 订阅'),
      el('p', 'status error', errorText(watchlistsResult)),
    ]);
  }
  const subscriptions = subscriptionsResult.data.subscriptions ?? [];
  const targets = (watchlistsResult.data.items ?? []).filter(
    ({ watchlist }) => watchlist.enabled && watchlist.kind !== 'system',
  );
  const select = el('select');
  for (const { watchlist } of targets) {
    const option = el('option', null, watchlist.name);
    option.value = watchlist.id;
    select.append(option);
  }
  const subscribe = el('button', 'btn btn-primary btn-sm', '订阅目标 Watchlist');
  subscribe.type = 'button';
  subscribe.disabled = targets.length === 0;
  subscribe.addEventListener('click', async () => {
    if (select.value.length === 0) return;
    const target = targets.find(({ watchlist }) => watchlist.id === select.value)?.watchlist;
    const confirmed = await confirmDialog({
      title: '订阅 Strategy 输出',
      message: `确认将 ${strategy.name} 的后续 published operational run 同步到“${target?.name ?? select.value}”？部分数据只会标 stale，试跑/评估/未发布运行不会改变 Watchlist。`,
      confirmLabel: '确认订阅',
    });
    if (!confirmed) return;
    subscribe.disabled = true;
    const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/watchlists`, {
      watchlistId: select.value,
    });
    subscribe.disabled = targets.length === 0;
    if (!result.ok) {
      setStatus(errorText(result), true);
      return;
    }
    responseCache.clear();
    setStatus(result.data.idempotent ? '订阅已存在' : 'Strategy→Watchlist 订阅已创建');
    await refresh();
  });
  const activeRows = subscriptions.map((subscription) => {
    const target = targets.find(({ watchlist }) => watchlist.id === subscription.watchlistId);
    const cancel = el('button', 'btn btn-outline btn-sm', '取消订阅');
    cancel.type = 'button';
    cancel.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: '取消 Strategy 订阅',
        message: `确认停止将 ${strategy.name} 的后续正式运行同步到“${target?.name ?? '已关联关注列表'}”？已有关注列表成员和同步历史不会被删除。`,
        confirmLabel: '取消订阅',
      });
      if (!confirmed) return;
      cancel.disabled = true;
      const result = await callApi(
        `/api/strategies/${encodeURIComponent(strategy.id)}/watchlists/${encodeURIComponent(subscription.watchlistId)}`,
        { method: 'DELETE', body: '{}' },
      );
      if (!result.ok) {
        cancel.disabled = false;
        setStatus(errorText(result), true);
        return;
      }
      responseCache.clear();
      setStatus('Strategy→Watchlist 订阅已取消');
      await refresh();
    });
    return el('article', 'entity-item', [
      el('div', 'flex gap-2', [
        el('strong', null, target?.name ?? '已关联关注列表'),
        el('span', 'badge badge-active', '同步中'),
      ]),
      el('p', 'muted', `创建于 ${fmtDateTime(subscription.createdAt)}`),
      cancel,
    ]);
  });
  return el('section', 'strategy-schedule-panel', [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('h3', null, 'Strategy → Watchlist 订阅'),
        el(
          'p',
          'muted',
          '必须显式选择目标。只有 published operational run 才会同步；partial 只标 stale，不根据缺失集合退出来源。',
        ),
      ]),
      el('div', 'row-actions', [select, subscribe]),
    ]),
    ...(targets.length === 0 ? [el('p', 'status warning', '没有可订阅的启用 Watchlist。')] : []),
    ...(activeRows.length === 0
      ? [el('p', 'placeholder', '当前没有 active Strategy→Watchlist 订阅。')]
      : [el('div', 'entity-list', activeRows)]),
  ]);
};

export const renderSettings = async (strategyId, setStatus, refresh) => {
  const [result, scheduleResult] = await Promise.all([
    cachedGet(`/api/strategies/${encodeURIComponent(strategyId)}`),
    cachedGet(`/api/strategies/${encodeURIComponent(strategyId)}/schedule`),
  ]);
  if (!result.ok) return el('p', 'status error', errorText(result));
  if (!scheduleResult.ok) return el('p', 'status error', errorText(scheduleResult));
  const { strategy, versions } = result.data;
  const subscriptionPanel = await renderStrategyWatchlistSubscriptions(
    strategy,
    setStatus,
    refresh,
  );
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
  const remove = el('button', 'btn btn-danger btn-sm', '删除策略');
  remove.type = 'button';
  remove.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: '删除策略',
      message: `确认删除“${strategy.name}”？版本、调度、运行结果、信号和观察数据都会一并删除，且无法撤销。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    remove.disabled = true;
    const deleted = await callApi(`/api/strategies/${encodeURIComponent(strategy.id)}`, {
      method: 'DELETE',
      body: '{}',
    });
    if (!deleted.ok) {
      remove.disabled = false;
      setStatus(errorText(deleted), true);
      return;
    }
    responseCache.clear();
    setStatus('策略已删除');
    window.location.hash = '#strategies';
  });
  actions.append(remove);
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
    subscriptionPanel,
    renderScheduleSettings(strategy, scheduleResult.data.schedule, setStatus, refresh),
  ]);
};

const renderTabContent = async (workspace, state, setStatus, refresh) => {
  if (state.tab === 'overview') return renderOverview(workspace, state);
  if (state.tab === 'pool') return renderPool(workspace.strategy.id, setStatus);
  if (state.tab === 'runs') return renderRuns(workspace.strategy.id, state.scope ?? 'operational');
  if (state.tab === 'insights')
    return renderInsights(workspace.strategy.id, setStatus, state.scope ?? 'operational', state);
  if (state.tab === 'cycle') return renderDecisionCycles(workspace.strategy.id, state);
  return renderSettings(workspace.strategy.id, setStatus, refresh);
};

export const parseBacktestStockIds = (value) => {
  const stockIds = [
    ...new Set(
      String(value ?? '')
        .split(/[\s,，;；]+/)
        .map((stockId) => stockId.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  return stockIds.length === 0 ? undefined : stockIds;
};

const BACKTEST_STATUS = {
  complete: ['完成', 'badge-active'],
  partial: ['部分完成', 'badge-important'],
  failed: ['失败', 'badge-pos'],
};

const VINTAGE_STATUS = {
  available: ['版本可用', 'badge-active'],
  unavailable: ['版本不可用', 'badge-important'],
  'not-applicable': ['不适用', 'badge-neutral'],
};

const STRICT_GATE_STATUS = {
  complete: ['完整', 'badge-active'],
  partial: ['部分可用', 'badge-important'],
  unavailable: ['不可用', 'badge-pos'],
};

export const buildStrictBacktestResultContent = (run) => {
  const gateRows = (run.gateAudit?.items ?? []).map((item) =>
    el('tr', null, [
      el('td', 'mono', item.key),
      el('td', null, badge(STRICT_GATE_STATUS[item.status], item.status)),
      el('td', 'muted', item.detail),
    ]),
  );
  const metrics = run.metrics;
  const metricNodes =
    metrics === undefined
      ? [
          el(
            'p',
            'status warning',
            '数据门禁未完整通过，净值、收益、回撤等指标暂不可用；不会输出伪造 Sharpe 或胜率。',
          ),
        ]
      : [
          el('div', 'strategy-summary-grid', [
            metric('最终净值', fmtNum(metrics.finalEquity)),
            metric('净收益', `${fmtSigned(metrics.netReturnPct)}%`),
            metric('最大回撤', `${fmtSigned(metrics.maxDrawdownPct)}%`),
            metric('基准收益', `${fmtSigned(metrics.benchmarkReturnPct)}%`),
            metric('超额收益', `${fmtSigned(metrics.excessReturnPct)}%`),
            metric('成交笔数', metrics.tradeCount),
          ]),
        ];
  return el('div', 'strategy-backtest-result', [
    el('p', 'muted', `严格回测 · ${run.status}`),
    ...metricNodes,
    el('h4', null, '门禁审计'),
    ...(gateRows.length === 0
      ? [el('p', 'placeholder', '暂无门禁审计。')]
      : [
          el('div', 'table-wrap', [
            el('table', 'table', [
              el(
                'thead',
                null,
                el(
                  'tr',
                  null,
                  ['门禁', '状态', '证据'].map((label) => el('th', null, label)),
                ),
              ),
              el('tbody', null, gateRows),
            ]),
          ]),
        ]),
    ...(run.error === undefined ? [] : [el('p', 'status error', run.error)]),
    el('p', 'muted', '严格回测与生产运行、历史评估隔离，不生成 Advice、Trade 或通知。'),
  ]);
};

export const runStrictStrategyBacktest = async (strategy, input, setStatus) => {
  setStatus('正在检查严格回测数据门禁…');
  const created = await post(
    `/api/strategies/${encodeURIComponent(strategy.id)}/strict-backtests`,
    input,
  );
  if (!created.ok) {
    setStatus(errorText(created), true);
    return created;
  }
  const initial = created.data?.run;
  const runId = initial?.id;
  if (typeof runId !== 'string') return created;
  let run = initial;
  for (
    let attempt = 0;
    attempt < 360 && (run.status === 'queued' || run.status === 'running');
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const snapshot = await callApi(
      `/api/strategies/${encodeURIComponent(strategy.id)}/strict-backtests/${encodeURIComponent(runId)}`,
    );
    if (!snapshot.ok) {
      setStatus(errorText(snapshot), true);
      return snapshot;
    }
    run = snapshot.data.run;
    setStatus(`严格回测：${run.status}，门禁 ${run.gateAudit?.status ?? 'unknown'}`);
  }
  openModal(`严格回测 · ${strategy.name}`, buildStrictBacktestResultContent(run));
  setStatus(
    run.metrics === undefined
      ? `严格回测${run.resultAvailability === 'unavailable' ? '不可用' : '部分完成'}：请查看门禁审计`
      : `严格回测完成：净收益 ${fmtSigned(run.metrics.netReturnPct)}%`,
    run.metrics === undefined,
  );
  return { ...created, data: { run } };
};

export const evaluationSessionOptions = (runs) => {
  const seen = new Set();
  const options = [];
  for (const run of runs ?? []) {
    const id = run.inputSnapshot?.evaluationSessionId;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const status = RUN_STATUS[run.status]?.[0] ?? run.status ?? '状态未知';
    options.push({
      value: id,
      label: `${fmtDateTime(run.startedAt ?? run.dataAsOf)} · ${status}`,
    });
  }
  return options;
};

const openStrictBacktestDialog = async (strategy, setStatus) => {
  const runsResult = await cachedGet(
    `/api/strategies/${encodeURIComponent(strategy.id)}/runs?scope=evaluation`,
  );
  if (!runsResult.ok) {
    setStatus(`历史评估记录加载失败：${errorText(runsResult)}`, true);
    return;
  }
  const sessionOptions = evaluationSessionOptions(runsResult.data.runs);
  if (sessionOptions.length === 0) {
    setStatus('请先完成一次模拟回测，再创建严格回测', true);
    return;
  }
  const values = await promptDialog({
    title: `严格回测 · ${strategy.name}`,
    fields: [
      {
        key: 'evaluationSessionId',
        label: '历史评估记录',
        value: sessionOptions[0].value,
        options: sessionOptions,
      },
      { key: 'initialCash', label: '初始资金', value: '1000000' },
      { key: 'commissionBps', label: '佣金（bps）', value: '3' },
      { key: 'minimumCommission', label: '最低佣金', value: '5' },
      { key: 'sellStampDutyBps', label: '卖出印花税（bps）', value: '5' },
      { key: 'buySlippageBps', label: '买入滑点（bps）', value: '2' },
      { key: 'sellSlippageBps', label: '卖出滑点（bps）', value: '2' },
    ],
    confirmLabel: '创建严格回测',
    note: '请选择一条已完成的历史评估。任一 PIT、修订、费用、滑点、可交易性、公司行动、基准或求值器身份门禁缺失时，只返回不可用/部分结果，不生成收益指标。',
  });
  if (values === null) return;
  await runStrictStrategyBacktest(
    strategy,
    {
      evaluationSessionId: values.evaluationSessionId,
      initialCash: Number(values.initialCash),
      costs: {
        commissionBps: Number(values.commissionBps),
        minimumCommission: Number(values.minimumCommission),
        sellStampDutyBps: Number(values.sellStampDutyBps),
        buySlippageBps: Number(values.buySlippageBps),
        sellSlippageBps: Number(values.sellSlippageBps),
      },
    },
    setStatus,
  );
};

export const buildBacktestResultContent = (data, strategyId = '') => {
  const summary = data.summary;
  const evaluationButton = el('button', 'btn btn-outline btn-sm', '查看历史评估记录');
  evaluationButton.type = 'button';
  const evaluationHash = buildStrategyHash({
    strategyId,
    tab: 'runs',
    scope: 'evaluation',
  });
  evaluationButton.addEventListener('click', () => {
    window.location.hash = evaluationHash;
    closeModal();
  });
  const rows = (data.days ?? []).map((day) =>
    el('tr', null, [
      el('td', 'mono', String(day.dataAsOf).slice(0, 10)),
      el('td', null, badge(BACKTEST_STATUS[day.status], day.status)),
      el('td', null, badge(VINTAGE_STATUS[day.vintageStatus], day.vintageStatus)),
      el('td', 'num mono', day.evaluatedCount ?? '--'),
      el('td', 'num mono', day.selectedCount ?? '--'),
      el('td', 'num mono', day.signalCount ?? '--'),
      el('td', 'num mono', day.failedCount ?? '--'),
      el('td', 'muted', day.error ?? ''),
    ]),
  );
  return el('div', 'strategy-backtest-result', [
    el('div', 'strategy-summary-grid', [
      metric(
        '交易日',
        summary.tradingDays,
        `完成 ${summary.completedDays} · 失败 ${summary.failedDays}`,
      ),
      metric('累计求值', summary.evaluatedCount),
      metric('累计入选', summary.selectedCount),
      metric('累计信号', summary.signalCount),
    ]),
    ...(strategyId.length === 0 ? [] : [el('div', 'modal-actions', evaluationButton)]),
    el(
      'p',
      'status warning',
      '这是按历史时点逐日重放的策略模拟，只统计规则命中与信号；不含收益、费用、滑点和可交易性模拟，不构成投资建议。',
    ),
    ...(rows.length === 0
      ? [el('p', 'placeholder', '所选区间没有交易日。')]
      : [
          el('div', 'table-wrap', [
            el('table', 'table', [
              el(
                'thead',
                null,
                el(
                  'tr',
                  null,
                  ['日期', '状态', '历史数据', '求值', '入选', '信号', '失败', '说明'].map(
                    (label) => el('th', null, label),
                  ),
                ),
              ),
              el('tbody', null, rows),
            ]),
          ]),
        ]),
  ]);
};

const buildBacktestProgressContent = (data, strategyId, sessionId, setStatus) => {
  const summary = data.summary ?? {
    tradingDays: 0,
    completedDays: 0,
    failedDays: 0,
    selectedCount: 0,
  };
  const cancel = el('button', 'btn btn-danger btn-sm', '取消历史评估');
  cancel.type = 'button';
  cancel.addEventListener('click', async () => {
    cancel.disabled = true;
    const result = await post(
      `/api/strategies/${encodeURIComponent(strategyId)}/backtests/${encodeURIComponent(sessionId)}/cancel`,
      {},
    );
    setStatus(result.ok ? '已请求取消历史评估，已完成日期会保留' : errorText(result), !result.ok);
  });
  return el('div', 'strategy-backtest-progress', [
    el(
      'p',
      null,
      `已完成 ${summary.completedDays ?? 0}/${summary.tradingDays ?? 0} 个交易日，失败 ${summary.failedDays ?? 0}，累计入选 ${summary.selectedCount ?? 0}`,
    ),
    el('p', 'muted', '任务在后台运行，页面会按日期刷新进度；历史评估不会替换当前生产股票池。'),
    el('div', 'modal-actions', [cancel]),
  ]);
};

export const runStrategyBacktest = async (strategy, input, setStatus) => {
  setStatus('正在逐交易日运行历史模拟…');
  const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/backtests`, input);
  if (!result.ok) {
    setStatus(errorText(result), true);
    return result;
  }
  let completed = result.data?.summary === undefined ? undefined : result.data;
  const sessionId = result.data?.sessionId ?? result.data?.session?.id;
  if (completed === undefined && typeof sessionId === 'string') {
    openModal(
      `模拟回测（历史回放）· ${strategy.name}`,
      buildBacktestProgressContent(result.data, strategy.id, sessionId, setStatus),
    );
    for (let attempt = 0; attempt < 360; attempt += 1) {
      const snapshot = await callApi(
        `/api/strategies/${encodeURIComponent(strategy.id)}/backtests/${encodeURIComponent(sessionId)}`,
      );
      if (!snapshot.ok) {
        setStatus(errorText(snapshot), true);
        return snapshot;
      }
      const data = snapshot.data;
      const summary = data.summary ?? {};
      setStatus(
        `历史评估进度：${summary.completedDays ?? 0}/${summary.tradingDays ?? 0} 个交易日，已入选 ${summary.selectedCount ?? 0}`,
      );
      if (data.status !== 'running' && data.session?.status !== 'running') {
        completed = data;
        break;
      }
      openModal(
        `模拟回测（历史回放）· ${strategy.name}`,
        buildBacktestProgressContent(data, strategy.id, sessionId, setStatus),
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (completed === undefined) {
    setStatus('历史评估仍在后台运行，可在执行记录中查看进度', false);
    return result;
  }
  responseCache.clear();
  openModal(
    `模拟回测（历史回放）· ${strategy.name}`,
    buildBacktestResultContent(completed, strategy.id, sessionId),
  );
  const completionLabel =
    completed.status === 'complete'
      ? '历史模拟完成'
      : completed.status === 'partial'
        ? '历史模拟部分完成'
        : '历史模拟失败或已取消';
  setStatus(
    `${completionLabel}：${completed.summary.completedDays}/${completed.summary.tradingDays} 个交易日，累计入选 ${completed.summary.selectedCount}，信号 ${completed.summary.signalCount}`,
    completed.status !== 'complete',
  );
  return { ...result, data: completed };
};

const localDateText = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const openBacktestDialog = async (strategy, setStatus) => {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  const values = await promptDialog({
    title: `模拟回测（历史回放）· ${strategy.name}`,
    fields: [
      { key: 'from', label: '开始日期（YYYY-MM-DD）', value: localDateText(from) },
      { key: 'to', label: '结束日期（YYYY-MM-DD）', value: localDateText(to) },
      {
        key: 'stockIds',
        label: '股票代码（可选，逗号或换行分隔）',
        value: '',
        multiline: true,
        rows: 4,
      },
    ],
    confirmLabel: '开始模拟',
    note: '最长 31 个自然日；留空将按历史时点全市场运行，可能耗时。结果保存为历史评估，不会替换当前股票池。',
  });
  if (values === null) return;
  const stockIds = parseBacktestStockIds(values.stockIds);
  if (stockIds !== undefined && stockIds.length > 500) {
    setStatus('模拟范围最多包含 500 只股票', true);
    return;
  }
  await runStrategyBacktest(
    strategy,
    {
      from: values.from,
      to: values.to,
      ...(stockIds === undefined ? {} : { stockIds }),
    },
    setStatus,
  );
};

const runAction = async (strategy, persist, setStatus, refresh, retryRunId) => {
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
      message:
        '将执行全市场扫描并原子落库。只有运行验收通过才会替换当前股票池；验收未通过或执行失败时保留上一份股票池。',
      confirmLabel: '开始运行',
    });
    if (!confirmed) return;
  }
  setStatus(persist ? '策略正式运行中…' : '策略样本试跑中…');
  const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/run`, {
    ...(stockIds === undefined ? {} : { stockIds }),
    persist,
    ...(retryRunId === undefined ? {} : { retryRunId }),
  });
  if (!result.ok) {
    setStatus(errorText(result), true);
    return;
  }
  responseCache.clear();
  const cycleItem = result.data?.item ?? result.data?.cycle?.items?.[0];
  if (persist && cycleItem !== undefined) {
    const cycleStatus =
      cycleItem.status === 'complete'
        ? '已完成'
        : cycleItem.status === 'partial'
          ? '部分完成'
          : cycleItem.status === 'skipped'
            ? '已跳过'
            : '失败';
    const publication =
      PUBLICATION_STATUS[cycleItem.publication]?.[0] ??
      (cycleItem.publication === undefined ? '' : cycleItem.publication);
    const selected =
      typeof cycleItem.selectedCount === 'number' ? `；入选 ${cycleItem.selectedCount}` : '';
    const failed =
      typeof cycleItem.failedCount === 'number' && cycleItem.failedCount > 0
        ? `；失败 ${cycleItem.failedCount}`
        : '';
    setStatus(
      `策略正式运行${cycleStatus}${publication.length > 0 ? ` · ${publication}` : ''}${selected}${failed}`,
    );
    await refresh();
    return;
  }
  const dataHealth =
    result.data.run.summary?.schemaVersion === 4 || result.data.run.summary?.schemaVersion === 3
      ? `，数据${DATA_HEALTH[result.data.run.summary.dataHealth] ?? result.data.run.summary.dataHealth}`
      : '';
  setStatus(
    persist
      ? `运行${RUN_STATUS[result.data.run.status]?.[0] ?? result.data.run.status}${dataHealth}；结果 ${result.data.results.length}，信号 ${result.data.signals.length}`
      : `试跑${RUN_STATUS[result.data.run.status]?.[0] ?? result.data.run.status}${dataHealth}；结果 ${result.data.results.length}（未落库）`,
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
    const strictBacktest = el('button', 'btn btn-outline btn-sm', '严格回测');
    strictBacktest.type = 'button';
    strictBacktest.addEventListener(
      'click',
      () => void openStrictBacktestDialog(workspace.strategy, setStatus),
    );
    const backtest = el('button', 'btn btn-outline btn-sm', '模拟回测');
    backtest.type = 'button';
    backtest.addEventListener(
      'click',
      () => void openBacktestDialog(workspace.strategy, setStatus),
    );
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
    headerActions.append(strictBacktest, backtest, sample, formal);
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
