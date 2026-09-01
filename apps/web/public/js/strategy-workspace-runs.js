import {
  badge,
  confirmDialog,
  createFeatureCache,
  createPagination,
  DATA_HEALTH,
  el,
  errorText,
  fmtDateTime,
  fmtNum,
  metric,
  mount,
  openModal,
  PUBLICATION_STATUS,
  post,
  RUN_SCOPE,
  RUN_STATUS,
  stockIdentityLink,
} from './strategy-workspace-shared.js';

const featureCache = createFeatureCache();
const { cachedGet } = featureCache;
export const invalidateRunsCache = () => featureCache.clear();

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

const runRow = (run, onRerun) => {
  const view = el('button', 'btn btn-outline btn-sm', '查看');
  view.type = 'button';
  view.addEventListener('click', () => void openRunDetail(run.id));
  const actions = [view];
  if (run.publication?.status === 'withheld' && onRerun !== undefined) {
    const rerun = el('button', 'btn btn-outline btn-sm', '重跑');
    rerun.type = 'button';
    rerun.addEventListener('click', () => void onRerun(rerun));
    actions.push(rerun);
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
    el('td', null, actions),
  ]);
};

/**
 * withheld 行的一键重跑：触发一次新的正式运行（mode=scan、persist），
 * 新运行仍走完整验收门——验收通过才发布替换 current，否则保留现有已发布结果。
 */
const rerunStrategy = async (strategyId, button, setLine, reload) => {
  const confirmed = await confirmDialog({
    title: '重跑策略',
    message:
      '将重新执行全市场扫描并原子落库。只有运行验收通过才会发布并替换当前结果；验收未通过或执行失败时保留现有已发布结果。',
    confirmLabel: '开始重跑',
  });
  if (!confirmed) return;
  button.disabled = true;
  button.textContent = '重跑中…';
  setLine('策略重跑中…');
  const result = await post(`/api/strategies/${encodeURIComponent(strategyId)}/run`, {
    persist: true,
  });
  button.disabled = false;
  button.textContent = '重跑';
  if (!result.ok) {
    setLine(errorText(result), true);
    return;
  }
  featureCache.clear();
  const run = result.data?.run ?? {};
  const statusText = RUN_STATUS[run.status]?.[0] ?? String(run.status ?? '完成');
  const publicationText = PUBLICATION_STATUS[run.publication?.status]?.[0];
  const resultsCount = result.data?.results?.length ?? 0;
  const signalsCount = result.data?.signals?.length ?? 0;
  setLine(
    `重跑${statusText}${publicationText === undefined ? '' : `，${publicationText}`}；结果 ${resultsCount}，信号 ${signalsCount}`,
  );
  await reload();
};

export const renderRuns = async (strategyId, scope = 'operational') => {
  const path = `/api/strategies/${encodeURIComponent(strategyId)}/runs?scope=${encodeURIComponent(scope)}`;
  const result = await cachedGet(path);
  if (!result.ok) return el('p', 'status error', errorText(result));
  const statusLine = el('p', 'status');
  statusLine.hidden = true;
  const setLine = (text, isError = false) => {
    statusLine.textContent = text;
    statusLine.className = isError ? 'status error' : 'status';
    statusLine.hidden = text.length === 0;
  };
  let runs = result.data.runs ?? [];
  const tbody = el('tbody');
  function renderPage() {
    const { page, pageSize } = pagination.getState();
    mount(
      tbody,
      runs.slice((page - 1) * pageSize, page * pageSize).map((run) => runRow(run, rerun)),
    );
  }
  const pagination = createPagination({ total: runs.length, onChange: renderPage });
  const reload = async () => {
    featureCache.delete(path);
    const fresh = await cachedGet(path);
    if (!fresh.ok) {
      setLine(errorText(fresh), true);
      return;
    }
    runs = fresh.data.runs ?? [];
    pagination.setState({ total: runs.length, page: 1 });
    renderPage();
  };
  const rerun = (button) => rerunStrategy(strategyId, button, setLine, reload);
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
    statusLine,
    tableWrap,
    pagination.root,
    ...(scope === 'operational'
      ? [await renderDiff(strategyId)]
      : [el('p', 'muted', '历史评估结果与生产 current 隔离；请选择具体运行后再做显式对比。')]),
  ]);
};
