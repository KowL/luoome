import { buildStrategyHash } from './strategy-workspace-route.js';
import {
  badge,
  callApi,
  changeClass,
  createFeatureCache,
  createPagination,
  el,
  errorText,
  fmtDateTime,
  fmtNum,
  fmtSigned,
  metric,
  mount,
  PUBLICATION_STATUS,
  post,
  promptDialog,
  RESULT_VIEW_STATUS,
  RULE_STATUS,
  sortableHeader,
  stockIdentityLink,
} from './strategy-workspace-shared.js';

const featureCache = createFeatureCache();
const { cachedGet } = featureCache;
export const invalidateOverviewCache = () => featureCache.clear();

const navigate = (state, patch) => {
  window.location.hash = buildStrategyHash({ ...state, ...patch });
};

export const renderHealthBanner = (workspace) => {
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

export const renderOverview = (workspace, state) => {
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

export const renderPool = async (strategyId, setStatus) => {
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
