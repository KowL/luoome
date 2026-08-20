import { callApi } from './api.js';
import { closeModal, confirmDialog, openModal, promptDialog } from './modal.js';
import { stockIdentityLink } from './stock-link.js';
import {
  invalidateStrategyWorkspaceCache,
  renderStrategyWorkspacePage,
} from './strategy-workspace.js';
import {
  $,
  compareValues,
  createPagination,
  el,
  fmtDateTime,
  fmtNum,
  fmtSigned,
  mount,
  sortableHeader,
  statBlock,
} from './ui.js';

const defaultOrderForKey = (key) => (key === 'price' ? 'asc' : 'desc');

const errorText = (result) => {
  const error = result?.error;
  if (error === undefined) return '操作失败';
  return `${error.kind ?? 'error'}：${error.message ?? error.required ?? error.cause ?? '操作失败'}`;
};

const post = (path, input, method = 'POST') =>
  callApi(path, { method, body: JSON.stringify(input) });

export const parseMemberStockIds = (value) => [
  ...new Set(
    value
      .split(/[\s,，;；]+/)
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  ),
];

export const appendMemberStock = (selected, stock, existingStockIds = []) => {
  const unavailable = new Set([...existingStockIds, ...selected.map((item) => item.id)]);
  return unavailable.has(stock.id) ? selected : [...selected, stock];
};

/** 触发条目时间行；字段名与 WatchTriggerSchema（只有 createdAt）对齐。 */
export const triggerMetaText = (trigger) =>
  `${trigger.alertPlanId} · 数据 ${new Date(trigger.createdAt).toLocaleString('zh-CN')}`;

export const buildAlertPlanMutationInput = (values, { editing = false } = {}) => {
  let rules;
  try {
    rules = JSON.parse(values.rulesJson);
  } catch {
    throw new Error('规则必须是合法 JSON');
  }
  if (!Array.isArray(rules) || rules.length === 0) throw new Error('至少配置一条规则');
  const cooldownMinutes = Number(values.cooldownMinutes);
  const dailyNotificationLimit = Number(values.dailyNotificationLimit);
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 0) {
    throw new Error('冷却分钟数必须是非负整数');
  }
  if (
    !Number.isInteger(dailyNotificationLimit) ||
    dailyNotificationLimit < 1 ||
    dailyNotificationLimit > 500
  ) {
    throw new Error('每日通知上限必须是 1～500 的整数');
  }
  const name = values.name.trim();
  const watchlistId = values.watchlistId.trim();
  if (name.length === 0) throw new Error('请输入预警名称');
  if (watchlistId.length === 0) throw new Error('请输入关注列表 ID');
  return {
    name,
    watchlistId,
    rules,
    logic: values.logic,
    triggerMode: values.triggerMode,
    ...(values.priority.length === 0
      ? editing
        ? { priority: null }
        : {}
      : { priority: values.priority }),
    cooldownMinutes,
    dailyNotificationLimit,
    notifyOnRecovery: values.notifyOnRecovery === 'true',
    enabled: values.enabled === 'true',
  };
};

const actionButton = (label, action, primary = false) => {
  const button = el('button', `btn ${primary ? 'btn-primary' : 'btn-outline'} btn-sm`, label);
  button.type = 'button';
  button.addEventListener('click', () => void action(button));
  return button;
};

const templateDefinition = {
  schemaVersion: 1,
  metadata: { horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      {
        id: 'positive-price',
        name: '价格有效',
        when: 'quote.close > 0',
        evidence: ['收盘价为正'],
      },
    ],
  },
  scoring: {
    method: 'weighted-sum',
    components: [{ ruleId: 'positive-price', score: '50', weight: 1 }],
  },
  signals: {
    entry: [
      {
        id: 'research-entry',
        name: '研究信号',
        when: 'quote.close > 0',
        score: '60',
        direction: 'bullish',
        evidence: ['仅用于研究，不构成交易指令'],
      },
    ],
    exit: [],
    risk: [],
  },
};

const STRATEGY_STYLE_TEXT = {
  momentum: '动量',
  'mean-reversion': '均值回复',
  volume: '量能',
  risk: '风控',
  pattern: '形态',
};

const WATCHLIST_KIND_TEXT = {
  personal: '个人',
  strategy: '策略',
  portfolio: '持仓',
  system: '系统',
};

const MEMBERSHIP_POLICY_TEXT = { manual: '手动', synced: '同步', mixed: '混合' };

const MEMBER_SOURCE_KIND_TEXT = {
  manual: '手动',
  strategy: '策略',
  ai: 'AI',
  portfolio: '持仓',
  import: '导入',
};

const MEMBER_SOURCE_STATUS_TEXT = { active: '活跃', stale: '过期', ended: '结束' };

const MEMBER_PRIORITY_TEXT = { normal: '普通', important: '重要', urgent: '紧急' };

let selectedStrategyId = '';

export const renderStrategies = async (setStatus) => {
  await renderStrategyWorkspacePage({
    setStatus,
    preferredStrategyId: selectedStrategyId,
    onSelect: (strategyId) => {
      selectedStrategyId = strategyId;
    },
  });
};

/**
 * 关注页主视图 + 已归档弹窗（PRD §10.1）的行数据：全部从 /api/watchlists/overview
 * 一次拉取的数据派生，切换视图不重复请求。
 */
export const deriveWatchlistViews = (overview) => {
  const listCards = (overview?.lists ?? [])
    .filter((row) => row.watchlist?.enabled !== false)
    .map((row) => ({
      watchlist: row.watchlist,
      memberCount: row.memberCount ?? 0,
      staleSources: row.sourceHealth?.stale ?? 0,
      todayEntered: row.todayEntered ?? 0,
      todayExited: row.todayExited ?? 0,
    }));
  const stocks = [...(overview?.stocks ?? [])].sort((a, b) => a.stockId.localeCompare(b.stockId));
  const todayChanges = [...(overview?.todayChanges ?? [])].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );
  return {
    listCards,
    stocks,
    todayChanges,
    archived: {
      lists: overview?.archived?.lists ?? [],
      members: overview?.archived?.members ?? [],
    },
  };
};

/** 股票视图排序：与首页看板同口径，按 |changePct| 降序，无行情（非数值）排最后。 */
export const sortStocksByQuote = (stocks) =>
  [...stocks].sort((a, b) => {
    const av = typeof a.changePct === 'number' ? Math.abs(a.changePct) : null;
    const bv = typeof b.changePct === 'number' ? Math.abs(b.changePct) : null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });

/** 成员来源健康摘要：active/stale 计数 + 最近 dataAsOf（无有效时间返回 null）。 */
export const summarizeMemberSources = (sources) => {
  let active = 0;
  let stale = 0;
  let latestDataAsOf = null;
  for (const source of sources ?? []) {
    if (source.status === 'active') active += 1;
    else if (source.status === 'stale') stale += 1;
    if (source.dataAsOf === undefined || source.dataAsOf === null) continue;
    const at = new Date(source.dataAsOf);
    if (Number.isNaN(at.getTime())) continue;
    if (latestDataAsOf === null || at > latestDataAsOf) latestDataAsOf = at;
  }
  return { active, stale, latestDataAsOf };
};

/** 某列表的成员股票：overview.stocks 中 memberships 含该 watchlistId 的项。 */
export const stocksOfList = (stocks, watchlistId) =>
  (stocks ?? []).filter((stock) =>
    (stock.memberships ?? []).some((membership) => membership.watchlistId === watchlistId),
  );

/** 股票区当前 tab（'all' 或 watchlistId）与最近一次 overview 数据：切换 tab 不重复拉取。 */
let watchlistStockTab = 'all';
let lastWatchlistOverview = null;

const memberSelect = (values, current, textMap) => {
  const select = document.createElement('select');
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = textMap[value] ?? value;
    option.selected = current === value;
    select.append(option);
  }
  return select;
};

const patchMember = (watchlistId, stockId, input) =>
  post(
    `/api/watchlists/${encodeURIComponent(watchlistId)}/members/${encodeURIComponent(stockId)}`,
    input,
    'PATCH',
  );

const archiveMember = (watchlistId, stockId) =>
  post(
    `/api/watchlists/${encodeURIComponent(watchlistId)}/members/${encodeURIComponent(stockId)}/archive`,
    {},
  );

/** 股票行情单元：现价 + 涨跌幅，红涨绿跌；无行情统一「--」。 */
const quoteCell = (stock) => {
  const chgCls =
    typeof stock.changePct !== 'number'
      ? ''
      : stock.changePct > 0
        ? 'pos'
        : stock.changePct < 0
          ? 'neg'
          : '';
  return [
    el(
      'td',
      `num ${chgCls}`,
      stock.quote === null || stock.quote === undefined ? '--' : fmtNum(stock.quote.close),
    ),
    el(
      'td',
      `num ${chgCls}`,
      typeof stock.changePct !== 'number' ? '--' : `${fmtSigned(stock.changePct)}%`,
    ),
  ];
};

/**
 * 全部股票视图的行情表：名称（链接行情页）/ 现价 / 涨跌幅 / 所属列表，
 * 列口径与首页实时看板一致。
 */
const stockTableRow = (stock) => {
  const holding = stock.memberships.some((membership) => membership.holding);
  return el('tr', null, [
    el(
      'td',
      null,
      el('div', 'board-name-cell', [
        stockIdentityLink({ stockId: stock.stockId, stockName: stock.name }),
        ...(holding ? [el('span', 'badge badge-holding', '持仓')] : []),
      ]),
    ),
    ...quoteCell(stock),
    el(
      'td',
      null,
      stock.memberships.map((membership) =>
        el('span', 'badge board-group-tag', membership.watchlistName),
      ),
    ),
  ]);
};

const buildStockTable = (pageItems, sortState, onSort) =>
  el('table', 'table board-table', [
    el(
      'thead',
      null,
      el('tr', null, [
        el('th', null, '名称'),
        sortableHeader('现价', 'price', sortState, onSort, 'num'),
        sortableHeader('涨跌幅', 'changePct', sortState, onSort, 'num'),
        el('th', null, '关注列表'),
      ]),
    ),
    el('tbody', null, pageItems.map(stockTableRow)),
  ]);

const renderStockTable = (stocks, emptyText) => {
  if (stocks.length === 0) return [el('p', 'placeholder', emptyText)];
  let sortState = { key: null, order: 'desc' };
  const getSortValue = (stock, key) =>
    key === 'price' ? (stock.quote?.close ?? null) : (stock.changePct ?? null);
  const sortedStocks = () => {
    if (sortState.key === null) return sortStocksByQuote(stocks);
    const direction = sortState.order === 'asc' ? 1 : -1;
    return [...stocks].sort(
      (a, b) =>
        direction * compareValues(getSortValue(a, sortState.key), getSortValue(b, sortState.key)),
    );
  };
  const onSort = (key) => {
    sortState =
      sortState.key === key
        ? { key, order: sortState.order === 'asc' ? 'desc' : 'asc' }
        : { key, order: defaultOrderForKey(key) };
    renderPage();
  };
  const listContainer = el('div', 'paginated-list');
  function renderPage() {
    const sorted = sortedStocks();
    const { page, pageSize } = pagination.getState();
    pagination.setState({ total: sorted.length });
    mount(
      listContainer,
      buildStockTable(sorted.slice((page - 1) * pageSize, page * pageSize), sortState, onSort),
    );
  }
  const pagination = createPagination({ total: stocks.length, onChange: renderPage });
  renderPage();
  return [listContainer, pagination.root];
};

const renderStocksView = (views) => renderStockTable(views.stocks, '暂无成员股票。');

/**
 * 单个列表 tab 的内容区：列表信息条（编辑/归档/加成员）+ 成员行情表
 * （优先级行内修改、来源、归档）。成员与行情来自 overview，
 * 列表元信息与关联预警计划经 get_watchlist 拉取。
 */
const renderListPane = async (watchlistId, views, setStatus) => {
  const view = $('#watchlists-view');
  if (view === null) return;
  mount(view, el('p', 'placeholder', '加载中…'));
  const result = await callApi(`/api/watchlists/${encodeURIComponent(watchlistId)}`);
  // 拉取期间用户已切走其它 tab，不再回填
  if (watchlistStockTab !== watchlistId) return;
  if (!result.ok) {
    mount(view, el('p', 'status error', errorText(result)));
    return;
  }
  const { watchlist, alertPlans } = result.data;
  const stocks = stocksOfList(views.stocks, watchlistId);

  const edit = actionButton('编辑', async () => {
    const values = await promptDialog({
      title: '编辑关注列表',
      fields: [
        { key: 'name', label: '名称', value: watchlist.name },
        { key: 'description', label: '描述', value: watchlist.description ?? '' },
        {
          key: 'enabled',
          label: '状态',
          value: watchlist.enabled ? 'true' : 'false',
          options: [
            { value: 'true', label: '启用' },
            { value: 'false', label: '停用' },
          ],
        },
      ],
      confirmLabel: '保存',
    });
    if (values === null || values.name.length === 0) return;
    const input = { name: values.name, enabled: values.enabled === 'true' };
    // description 可清空：已有描述时始终带上，允许改成空串
    if (values.description.length > 0 || watchlist.description !== undefined) {
      input.description = values.description;
    }
    const updated = await post(
      `/api/watchlists/${encodeURIComponent(watchlist.id)}`,
      input,
      'PATCH',
    );
    setStatus(updated.ok ? '关注列表已更新' : errorText(updated), !updated.ok);
    await renderWatchlists(setStatus);
  });

  const archiveList = actionButton('归档列表', async () => {
    const confirmed = await confirmDialog({
      title: '归档关注列表',
      message: `归档后列表「${watchlist.name}」将停用，成员与历史保留。确认归档？`,
      confirmLabel: '归档',
      danger: true,
    });
    if (!confirmed) return;
    const archived = await post(`/api/watchlists/${encodeURIComponent(watchlist.id)}/archive`, {});
    if (!archived.ok) {
      setStatus(errorText(archived), true);
      return;
    }
    watchlistStockTab = 'all';
    setStatus('关注列表已归档');
    await renderWatchlists(setStatus);
  });

  const add = actionButton('添加成员', async () => {
    const searchInput = el('input');
    searchInput.type = 'search';
    searchInput.placeholder = '输入股票代码或名称，例如 600519 / 贵州茅台';
    searchInput.autocomplete = 'off';
    searchInput.setAttribute('aria-label', '搜索股票代码或名称');
    searchInput.setAttribute('aria-autocomplete', 'list');

    const resultList = el('div', 'autocomplete-list member-picker-results');
    resultList.hidden = true;
    resultList.setAttribute('role', 'listbox');
    const searchWrap = el('div', 'autocomplete', [searchInput, resultList]);
    const selectionList = el('div', 'member-picker-selection');
    const selectionHint = el('p', 'member-picker-count', '尚未选择股票');
    const reasonInput = el('input');
    reasonInput.type = 'text';
    reasonInput.placeholder = '可空，默认「用户手工添加」';
    const errorNode = el('p', 'modal-error');
    const submit = el('button', 'btn btn-primary', '添加 0 只');
    submit.type = 'button';
    submit.disabled = true;

    const existingStockIds = stocks.map((stock) => stock.stockId);
    let selected = [];
    let candidates = [];
    let activeIndex = -1;
    let timer = 0;
    let requestId = 0;

    const renderSelection = () => {
      selectionHint.textContent =
        selected.length === 0 ? '尚未选择股票' : `已选择 ${selected.length} 只股票`;
      submit.textContent = `添加 ${selected.length} 只`;
      submit.disabled = selected.length === 0;
      selectionList.replaceChildren(
        ...selected.map((stock) => {
          const remove = el('button', 'member-picker-remove', '移除');
          remove.type = 'button';
          remove.setAttribute('aria-label', `移除 ${stock.name ?? stock.id}`);
          remove.addEventListener('click', () => {
            selected = selected.filter((item) => item.id !== stock.id);
            renderSelection();
          });
          return el('div', 'member-picker-selected', [
            el('div', null, [
              el('strong', null, stock.name ?? stock.id),
              el('span', 'mono muted', stock.id),
            ]),
            remove,
          ]);
        }),
      );
    };

    const chooseCandidate = (stock) => {
      const before = selected.length;
      selected = appendMemberStock(selected, stock, existingStockIds);
      if (selected.length === before) return;
      searchInput.value = '';
      resultList.hidden = true;
      candidates = [];
      activeIndex = -1;
      errorNode.textContent = '';
      renderSelection();
      searchInput.focus();
    };

    const renderCandidates = () => {
      activeIndex = Math.min(activeIndex, candidates.length - 1);
      const selectedIds = new Set(selected.map((stock) => stock.id));
      const existingIds = new Set(existingStockIds);
      const nodes = candidates.map((stock, index) => {
        const exists = existingIds.has(stock.id);
        const chosen = selectedIds.has(stock.id);
        const item = el('button', 'autocomplete-item autocomplete-rich');
        item.type = 'button';
        item.disabled = exists || chosen;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(chosen));
        if (index === activeIndex) item.classList.add('is-active');
        item.append(
          el('span', 'ac-line-1', [
            el('span', 'mono', stock.code ?? stock.id),
            el('span', 'ac-name', stock.name ?? '未命名股票'),
          ]),
          el(
            'span',
            `member-picker-state${exists || chosen ? ' muted' : ''}`,
            exists ? '已在分组' : chosen ? '已选择' : (stock.exchange ?? ''),
          ),
        );
        item.addEventListener('pointerdown', (event) => event.preventDefault());
        item.addEventListener('click', () => chooseCandidate(stock));
        return item;
      });
      if (nodes.length === 0) {
        nodes.push(el('p', 'member-picker-empty', '未找到匹配的股票'));
      }
      resultList.replaceChildren(...nodes);
      resultList.hidden = false;
    };

    const search = async (query) => {
      const currentRequest = ++requestId;
      resultList.replaceChildren(el('p', 'member-picker-empty', '搜索中…'));
      resultList.hidden = false;
      const response = await callApi(`/api/stocks/search?q=${encodeURIComponent(query)}&limit=10`);
      if (currentRequest !== requestId || searchInput.value.trim() !== query) return;
      if (!response.ok) {
        candidates = [];
        resultList.replaceChildren(el('p', 'member-picker-empty modal-error', errorText(response)));
        resultList.hidden = false;
        return;
      }
      candidates = Array.isArray(response.data?.stocks) ? response.data.stocks : [];
      activeIndex = candidates.findIndex(
        (stock) => !existingStockIds.includes(stock.id) && !selected.some((s) => s.id === stock.id),
      );
      renderCandidates();
    };

    searchInput.addEventListener('input', () => {
      window.clearTimeout(timer);
      const query = searchInput.value.trim();
      if (query.length === 0) {
        requestId += 1;
        resultList.hidden = true;
        candidates = [];
        return;
      }
      timer = window.setTimeout(() => void search(query), 250);
    });
    searchInput.addEventListener('focus', () => {
      if (candidates.length > 0) renderCandidates();
    });
    searchInput.addEventListener('blur', () => {
      window.setTimeout(() => {
        resultList.hidden = true;
      }, 100);
    });
    searchInput.addEventListener('keydown', (event) => {
      if (resultList.hidden || candidates.length === 0) return;
      const available = candidates
        .map((stock, index) => ({ stock, index }))
        .filter(
          ({ stock }) =>
            !existingStockIds.includes(stock.id) && !selected.some((item) => item.id === stock.id),
        );
      if (available.length === 0) return;
      const current = available.findIndex(({ index }) => index === activeIndex);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const next = (current + direction + available.length) % available.length;
        activeIndex = available[next].index;
        renderCandidates();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        chooseCandidate(available[Math.max(0, current)].stock);
      }
    });

    submit.addEventListener('click', () => {
      void (async () => {
        submit.disabled = true;
        errorNode.textContent = '';
        const reason = reasonInput.value.trim();
        const members = selected.map((stock) => ({
          stockId: stock.id,
          ...(reason ? { reason } : {}),
        }));
        const added = await post(
          `/api/watchlists/${encodeURIComponent(watchlist.id)}/members/batch`,
          { members },
        );
        if (!added.ok) {
          errorNode.textContent = errorText(added);
          submit.disabled = false;
          return;
        }
        closeModal();
        setStatus(`已加入 ${members.length} 个成员`);
        await renderWatchlists(setStatus);
      })();
    });

    const cancel = el('button', 'btn btn-outline', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', closeModal);
    const actions = el('div', 'modal-actions', [cancel, submit]);
    const body = el('div', 'member-picker', [
      el('p', 'muted', `搜索股票并加入「${watchlist.name}」，支持一次选择多只。`),
      el('div', 'field', [el('label', null, '股票代码或名称'), searchWrap]),
      el('div', 'member-picker-selection-head', [el('strong', null, '待添加成员'), selectionHint]),
      selectionList,
      el('div', 'field', [el('label', null, '加入原因'), reasonInput]),
      errorNode,
      actions,
    ]);
    openModal('添加分组成员', body);
    searchInput.focus();
  });
  const health = summarizeMemberSources(
    stocks.flatMap((stock) =>
      (stock.memberships ?? [])
        .filter((membership) => membership.watchlistId === watchlistId)
        .flatMap((membership) => membership.sources ?? []),
    ),
  );

  let sortState = { key: null, order: 'desc' };
  const getSortValue = (stock, key) =>
    key === 'price' ? (stock.quote?.close ?? null) : (stock.changePct ?? null);
  const sortedStocks = () => {
    if (sortState.key === null) return sortStocksByQuote(stocks);
    const direction = sortState.order === 'asc' ? 1 : -1;
    return [...stocks].sort(
      (a, b) =>
        direction * compareValues(getSortValue(a, sortState.key), getSortValue(b, sortState.key)),
    );
  };
  const onSort = (key) => {
    sortState =
      sortState.key === key
        ? { key, order: sortState.order === 'asc' ? 'desc' : 'asc' }
        : { key, order: defaultOrderForKey(key) };
    renderPage();
  };

  const listMemberRow = (stock) => {
    const membership = stock.memberships.find((m) => m.watchlistId === watchlistId);
    const priority = memberSelect(
      ['normal', 'important', 'urgent'],
      membership.priority,
      MEMBER_PRIORITY_TEXT,
    );
    priority.addEventListener('change', async () => {
      const updated = await patchMember(watchlist.id, stock.stockId, {
        priority: priority.value,
      });
      setStatus(updated.ok ? '优先级已更新' : errorText(updated), !updated.ok);
    });
    const archive = actionButton('归档', async (button) => {
      button.disabled = true;
      const archived = await archiveMember(watchlist.id, stock.stockId);
      setStatus(archived.ok ? `${stock.stockId} 已归档` : errorText(archived), !archived.ok);
      await renderWatchlists(setStatus);
    });
    const sources = membership.sources ?? [];
    return el('tr', null, [
      el(
        'td',
        null,
        el('div', 'board-name-cell', [
          stockIdentityLink({ stockId: stock.stockId, stockName: stock.name }),
          ...(membership.holding ? [el('span', 'badge badge-holding', '持仓')] : []),
        ]),
      ),
      ...quoteCell(stock),
      el('td', null, priority),
      el(
        'td',
        null,
        sources.length === 0
          ? el('span', 'muted', '无来源')
          : sources.map((source) =>
              el(
                'span',
                'badge badge-neutral',
                `${MEMBER_SOURCE_KIND_TEXT[source.kind] ?? source.kind}·${MEMBER_SOURCE_STATUS_TEXT[source.status] ?? source.status}`,
              ),
            ),
      ),
      el('td', null, archive),
    ]);
  };

  const buildListTable = (pageItems) =>
    el('table', 'table board-table', [
      el(
        'thead',
        null,
        el('tr', null, [
          el('th', null, '名称'),
          sortableHeader('现价', 'price', sortState, onSort, 'num'),
          sortableHeader('涨跌幅', 'changePct', sortState, onSort, 'num'),
          el('th', null, '优先级'),
          el('th', null, '来源'),
          el('th', null, '操作'),
        ]),
      ),
      el('tbody', null, pageItems.map(listMemberRow)),
    ]);

  const listContainer = el('div', 'paginated-list');
  function renderPage() {
    const sorted = sortedStocks();
    const { page, pageSize } = pagination.getState();
    pagination.setState({ total: sorted.length });
    mount(listContainer, buildListTable(sorted.slice((page - 1) * pageSize, page * pageSize)));
  }
  const pagination = createPagination({ total: stocks.length, onChange: renderPage });

  const plansLine =
    alertPlans.length === 0
      ? null
      : el('p', 'muted', [
          `预警计划 ${alertPlans.length} 个：${alertPlans.map((plan) => plan.name).join('、')} · `,
          (() => {
            const link = el('a', null, '去预警计划页管理');
            link.href = '#alerts';
            return link;
          })(),
        ]);

  const children = [
    el('div', 'watchlist-pane-head', [
      el('div', 'flex gap-2', [
        el('h2', null, watchlist.name),
        ...(watchlist.enabled ? [] : [el('span', 'badge badge-paused', '停用')]),
      ]),
      el('div', 'flex gap-2', [edit, archiveList, add]),
    ]),
    el(
      'p',
      'muted',
      `${WATCHLIST_KIND_TEXT[watchlist.kind] ?? watchlist.kind} · ${MEMBERSHIP_POLICY_TEXT[watchlist.membershipPolicy] ?? watchlist.membershipPolicy}${watchlist.description ? ` · ${watchlist.description}` : ''} · 来源健康：活跃 ${health.active} · 过期 ${health.stale}${health.latestDataAsOf === null ? '' : ` · 最近数据 ${fmtDateTime(health.latestDataAsOf)}`}`,
    ),
    ...(plansLine === null ? [] : [plansLine]),
  ];
  if (stocks.length === 0) {
    children.push(el('p', 'placeholder', '暂无成员。'));
  } else {
    renderPage();
    children.push(listContainer, pagination.root);
  }
  mount(view, children);
};

const renderTodayView = (views) =>
  views.todayChanges.length === 0
    ? [el('p', 'placeholder', '今日暂无成员变化。')]
    : views.todayChanges.map((change) =>
        el('div', 'entity-item', [
          el('div', 'flex gap-2', [
            el('strong', null, `${change.watchlistName} · ${change.stockId}`),
            el(
              'span',
              `badge ${change.direction === 'entered' ? 'badge-pos' : 'badge-neg'}`,
              change.direction === 'entered' ? '进入' : '退出',
            ),
          ]),
          el('div', 'muted', `${change.reason} · ${fmtDateTime(change.at)}`),
        ]),
      );

/** 已归档弹窗：只读历史区，由页头按钮打开，不占主视图 tab。 */
const openArchivedDialog = () => {
  const overview = lastWatchlistOverview;
  if (overview === null) return;
  const archived = deriveWatchlistViews(overview).archived;
  openModal(
    '已归档',
    el('div', null, [
      el('p', 'muted', '列表归档即停用，成员与历史保留。'),
      el('h3', null, `已归档列表 ${archived.lists.length}`),
      ...(archived.lists.length === 0
        ? [el('p', 'placeholder', '暂无已归档列表。')]
        : archived.lists.map((watchlist) =>
            el('div', 'entity-item', [
              el('div', 'flex gap-2', [
                el('strong', null, watchlist.name),
                el(
                  'span',
                  'badge badge-neutral',
                  WATCHLIST_KIND_TEXT[watchlist.kind] ?? watchlist.kind,
                ),
                el('span', 'badge badge-paused', '停用'),
              ]),
            ]),
          )),
      el('h3', 'mt-4', `已归档成员 ${archived.members.length}`),
      ...(archived.members.length === 0
        ? [el('p', 'placeholder', '暂无已归档成员。')]
        : archived.members.map((item) =>
            el('div', 'entity-item', [
              el('strong', null, `${item.watchlistName} · ${item.member.stockId}`),
              el('div', 'muted', `归档于 ${fmtDateTime(item.member.archivedAt)}`),
            ]),
          )),
    ]),
  );
};

const renderWatchlistOverview = (setStatus) => {
  const overview = lastWatchlistOverview;
  if (overview === null) return;
  const views = deriveWatchlistViews(overview);
  const sum = (pick) => views.listCards.reduce((total, card) => total + pick(card), 0);
  // 「今日变化」卡片可点击，平滑滚动到页面对应区块
  const scrollTo = (selector) => () =>
    document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const todayStat = statBlock(
    '今日变化',
    `+${sum((card) => card.todayEntered)} / -${sum((card) => card.todayExited)}`,
  );
  todayStat.classList.add('stat-clickable');
  todayStat.title = '点击跳转到今日变化';
  todayStat.addEventListener('click', scrollTo('#watchlists-today-pane'));
  const summary = $('#watchlists-summary');
  if (summary !== null) {
    mount(summary, [
      statBlock('关注列表', String(views.listCards.length)),
      statBlock('成员', String(sum((card) => card.memberCount))),
      todayStat,
    ]);
  }
  // 异常提示降级为 tab 栏右侧一行小字，只在非 0 时出现，不占 stat 首屏
  const hints = $('#watchlists-hints');
  if (hints !== null) {
    const stale = sum((card) => card.staleSources);
    const urgentImportant = overview.triggers?.urgentImportantCount ?? 0;
    const parts = [
      ...(stale > 0 ? [`过期来源 ${stale}`] : []),
      ...(urgentImportant > 0 ? [`紧急/重要触发 ${urgentImportant}`] : []),
    ];
    hints.hidden = parts.length === 0;
    hints.textContent = parts.join(' · ');
  }
  // 股票区 tab：全部 + 每个列表；当前 tab 失效（列表被归档）时回落「全部」
  const listTabs = [
    { key: 'all', label: '全部' },
    ...views.listCards.map((card) => ({ key: card.watchlist.id, label: card.watchlist.name })),
  ];
  if (!listTabs.some((tab) => tab.key === watchlistStockTab)) watchlistStockTab = 'all';
  const tabs = $('#watchlists-tabs');
  if (tabs !== null) {
    mount(
      tabs,
      listTabs.map((tab) => {
        const button = el(
          'button',
          `btn btn-sm ${tab.key === watchlistStockTab ? 'btn-primary' : 'btn-outline'}`,
          tab.label,
        );
        button.type = 'button';
        button.addEventListener('click', () => {
          watchlistStockTab = tab.key;
          renderWatchlistOverview(setStatus);
        });
        return button;
      }),
    );
  }
  // 页头「已归档」按钮带总数（列表 + 成员），点击弹窗查看
  const archivedBtn = $('#btn-watchlist-archived');
  if (archivedBtn !== null) {
    const archivedCount = views.archived.lists.length + views.archived.members.length;
    archivedBtn.textContent = archivedCount > 0 ? `已归档 ${archivedCount}` : '已归档';
  }
  // 第二层级：股票区（全部行情表 / 单列表管理面板）
  const view = $('#watchlists-view');
  if (view !== null) {
    if (watchlistStockTab === 'all') mount(view, renderStocksView(views));
    else void renderListPane(watchlistStockTab, views, setStatus);
  }
  // 第三层级：今日变化区块
  const today = $('#watchlists-today');
  if (today !== null) mount(today, renderTodayView(views));
};

export const renderWatchlists = async (setStatus) => {
  const result = await callApi('/api/watchlists/overview');
  const view = $('#watchlists-view');
  if (view === null) return;
  if (!result.ok) {
    mount(view, el('p', 'status error', errorText(result)));
    return;
  }
  lastWatchlistOverview = result.data;
  renderWatchlistOverview(setStatus);
};

const editAlertPlan = async (plan, setStatus) => {
  const creating = plan === null;
  const watchlistId = creating
    ? watchlistStockTab === 'all'
      ? ''
      : watchlistStockTab
    : plan.watchlistId;
  const values = await promptDialog({
    title: creating ? '新建预警' : '编辑预警',
    note: '规则使用 AlertRule JSON 数组；每条规则必须保留稳定且唯一的 id。',
    fields: [
      {
        key: 'name',
        label: '名称',
        value: creating ? `${watchlistId || '关注列表'} 价格预警` : plan.name,
      },
      { key: 'watchlistId', label: '关注列表 ID', value: watchlistId },
      {
        key: 'rulesJson',
        label: '规则 JSON',
        multiline: true,
        rows: 10,
        value: JSON.stringify(
          creating
            ? [{ id: 'price-level-1', kind: 'price-level', level: 10, side: 'above' }]
            : plan.rules,
          null,
          2,
        ),
      },
      {
        key: 'logic',
        label: '组合逻辑',
        value: creating ? 'ANY' : plan.logic,
        options: [
          { value: 'ANY', label: '任一规则命中' },
          { value: 'ALL', label: '全部规则命中' },
        ],
      },
      {
        key: 'triggerMode',
        label: '触发模式',
        value: creating ? 'on-enter' : plan.triggerMode,
        options: [
          { value: 'on-enter', label: '进入条件时' },
          { value: 'daily-first', label: '每日首次' },
          { value: 'repeat', label: '持续重复' },
        ],
      },
      {
        key: 'priority',
        label: '默认优先级',
        value: creating ? '' : (plan.priority ?? ''),
        options: [
          { value: '', label: '按规则推导' },
          { value: 'normal', label: '普通' },
          { value: 'important', label: '重要' },
          { value: 'urgent', label: '紧急' },
        ],
      },
      {
        key: 'cooldownMinutes',
        label: '冷却分钟数',
        value: String(creating ? 30 : plan.cooldownMinutes),
      },
      {
        key: 'dailyNotificationLimit',
        label: '每日通知上限',
        value: String(creating ? 20 : plan.dailyNotificationLimit),
      },
      {
        key: 'notifyOnRecovery',
        label: '恢复时通知',
        value: String(creating ? false : plan.notifyOnRecovery),
        options: [
          { value: 'false', label: '否' },
          { value: 'true', label: '是' },
        ],
      },
      {
        key: 'enabled',
        label: '状态',
        value: String(creating ? true : plan.enabled),
        options: [
          { value: 'true', label: '启用' },
          { value: 'false', label: '停用' },
        ],
      },
    ],
    confirmLabel: creating ? '创建' : '保存',
  });
  if (values === null) return false;
  let input;
  try {
    input = buildAlertPlanMutationInput(values, { editing: !creating });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '预警配置无效', true);
    return false;
  }
  const result = await post(
    creating ? '/api/alert-plans' : `/api/alert-plans/${encodeURIComponent(plan.id)}`,
    input,
    creating ? 'POST' : 'PATCH',
  );
  setStatus(result.ok ? (creating ? '预警已创建' : '预警已更新') : errorText(result), !result.ok);
  return result.ok;
};

const planCard = (plan, setStatus) => {
  const edit = actionButton('编辑', async () => {
    if (await editAlertPlan(plan, setStatus)) await renderAlerts(setStatus);
  });
  const remove = actionButton('删除', async () => {
    const confirmed = await confirmDialog({
      title: '删除预警',
      message: `确认删除「${plan.name}」？历史触发记录会保留。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    const result = await post(`/api/alert-plans/${encodeURIComponent(plan.id)}`, {}, 'DELETE');
    setStatus(result.ok ? '预警已删除' : errorText(result), !result.ok);
    if (result.ok) await renderAlerts(setStatus);
  });
  return el('div', 'entity-item', [
    el('strong', null, plan.name),
    el(
      'span',
      'muted',
      `${plan.watchlistId} · ${plan.rules.length} 条规则 · ${plan.logic} · ${plan.triggerMode} · 冷却 ${plan.cooldownMinutes} 分钟 · 日上限 ${plan.dailyNotificationLimit}`,
    ),
    el(
      'span',
      `badge ${plan.enabled ? 'badge-active' : 'badge-neutral'}`,
      plan.enabled ? '启用' : '停用',
    ),
    el('div', 'flex gap-2', [edit, remove]),
  ]);
};

const triggerCard = (trigger) =>
  el('div', 'entity-item', [
    el('strong', null, `${trigger.stockId} · ${trigger.ruleKind}`),
    el('div', 'muted', triggerMetaText(trigger)),
    el('div', null, (trigger.evidence ?? []).join('；')),
  ]);

const mountPaginated = (root, items, renderItem, emptyNode) => {
  if (root === null) return;
  let paginationWrap = root.nextElementSibling;
  if (
    paginationWrap === null ||
    !(paginationWrap instanceof Element) ||
    !paginationWrap.classList.contains('pagination-wrap')
  ) {
    paginationWrap = document.createElement('div');
    paginationWrap.className = 'pagination-wrap';
    root.after(paginationWrap);
  }
  if (items.length === 0) {
    mount(root, emptyNode);
    paginationWrap.replaceChildren();
    return;
  }
  function renderPage() {
    const { page, pageSize } = pagination.getState();
    mount(root, items.slice((page - 1) * pageSize, page * pageSize).map(renderItem));
  }
  const pagination = createPagination({ total: items.length, onChange: renderPage });
  renderPage();
  mount(paginationWrap, pagination.root);
};

export const renderAlerts = async (setStatus) => {
  const [plansResult, triggersResult] = await Promise.all([
    callApi('/api/alert-plans'),
    callApi('/api/watch/triggers?limit=50'),
  ]);
  const plansRoot = $('#alerts-list');
  const triggersRoot = $('#alerts-triggers');
  if (plansRoot !== null) {
    const plans = plansResult.ok ? (plansResult.data.plans ?? []) : [];
    const meta = $('#alerts-meta');
    if (meta !== null) meta.textContent = `${plans.length} 个`;
    if (plansResult.ok) {
      mountPaginated(
        plansRoot,
        plans,
        (plan) => planCard(plan, setStatus),
        el('p', 'placeholder', '暂无预警计划。'),
      );
    } else {
      mount(plansRoot, el('p', 'status error', errorText(plansResult)));
    }
  }
  if (triggersRoot !== null) {
    const triggers = triggersResult.ok ? (triggersResult.data.triggers ?? []) : [];
    if (triggersResult.ok) {
      mountPaginated(triggersRoot, triggers, triggerCard, el('p', 'placeholder', '暂无触发记录。'));
    } else {
      mount(triggersRoot, el('p', 'status error', errorText(triggersResult)));
    }
  }
  void setStatus;
};

const openStrategyCreateModal = (setStatus, refresh) => {
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.placeholder = '策略名称';
  const descInput = el('input');
  descInput.type = 'text';
  descInput.placeholder = '策略描述';
  const defInput = el('textarea', 'strategy-def-input');
  defInput.rows = 16;
  defInput.spellcheck = false;
  defInput.wrap = 'off';
  defInput.value = JSON.stringify(templateDefinition, null, 2);

  const templateSelect = el('select');
  const customOption = document.createElement('option');
  customOption.value = '';
  customOption.textContent = '自定义策略（空白模板）';
  templateSelect.append(customOption);
  const templateHint = el('p', 'hint', '加载模板中…');

  let selectedTemplate = null;
  templateSelect.addEventListener('change', () => {
    const template = templates.find((item) => item.id === templateSelect.value) ?? null;
    selectedTemplate = template;
    if (template === null) {
      defInput.value = JSON.stringify(templateDefinition, null, 2);
      return;
    }
    nameInput.value = template.name;
    descInput.value = template.description;
    defInput.value = JSON.stringify(template.definition, null, 2);
  });

  let templates = [];
  const loadTemplates = async () => {
    const result = await callApi('/api/strategy-templates');
    if (!result.ok) {
      templateHint.textContent = errorText(result);
      templateHint.className = 'status error';
      return;
    }
    templates = result.data.templates ?? [];
    templateHint.textContent =
      templates.length === 0
        ? '暂无可用模板，将使用空白模板'
        : '选择模板后自动带出策略定义，可继续编辑';
    for (const template of templates) {
      const option = document.createElement('option');
      option.value = template.id;
      const style = STRATEGY_STYLE_TEXT[template.definition?.metadata?.style];
      option.textContent = style === undefined ? template.name : `${template.name}（${style}）`;
      templateSelect.append(option);
    }
  };
  void loadTemplates();

  const submit = actionButton(
    '创建',
    async (button) => {
      const name = nameInput.value.trim();
      if (name.length === 0) {
        setStatus('请输入策略名称', true);
        return;
      }
      const description = descInput.value.trim();
      if (description.length === 0) {
        setStatus('请输入策略描述', true);
        return;
      }
      let definition;
      try {
        definition = JSON.parse(defInput.value);
      } catch {
        setStatus('策略定义不是合法 JSON', true);
        return;
      }
      const changeSummary =
        selectedTemplate === null ? '自定义创建' : `从模板「${selectedTemplate.name}」创建`;
      button.disabled = true;
      const created = await post('/api/strategies', { name, description });
      if (!created.ok) {
        setStatus(errorText(created), true);
        button.disabled = false;
        return;
      }
      const versioned = await post(
        `/api/strategies/${encodeURIComponent(created.data.strategy.id)}/versions`,
        { definition, changeSummary },
      );
      button.disabled = false;
      if (!versioned.ok) {
        setStatus(errorText(versioned), true);
        return;
      }
      closeModal();
      selectedStrategyId = created.data.strategy.id;
      invalidateStrategyWorkspaceCache();
      window.location.hash = `#strategies?strategyId=${encodeURIComponent(selectedStrategyId)}&tab=settings&view=rule-near-miss`;
      setStatus(selectedTemplate === null ? '策略已创建' : '策略已从模板创建');
      await refresh('strategies');
    },
    true,
  );
  openModal(
    '新增策略',
    el('div', 'modal-form', [
      el('p', 'hint', '模板'),
      templateSelect,
      templateHint,
      el('p', 'hint', '名称'),
      nameInput,
      el('p', 'hint', '描述'),
      descInput,
      el('p', 'hint', '策略定义（JSON，DSL v1；selection 至少一条规则，scoring 权重之和为 1）'),
      defInput,
      el('div', 'modal-actions', [submit]),
    ]),
  );
};

export const initTargetActions = ({ setStatus, refresh }) => {
  $('#btn-strategy-create')?.addEventListener('click', () =>
    openStrategyCreateModal(setStatus, refresh),
  );
  $('#btn-watchlist-archived')?.addEventListener('click', openArchivedDialog);
  $('#btn-watchlist-create')?.addEventListener('click', async () => {
    const values = await promptDialog({
      title: '新建关注列表',
      note: '个人列表；策略/持仓列表由系统自动维护',
      fields: [{ key: 'name', label: '名称', value: '研究候选' }],
      confirmLabel: '创建',
    });
    const name = values?.name;
    if (name === undefined || name.length === 0) return;
    const result = await post('/api/watchlists', {
      name,
      kind: 'personal',
      membershipPolicy: 'mixed',
    });
    setStatus(result.ok ? '关注列表已创建' : errorText(result), !result.ok);
    // 创建成功后切到新列表的 tab
    if (result.ok) watchlistStockTab = result.data.watchlist.id;
    await refresh('watchlists');
  });
  $('#btn-alert-create')?.addEventListener('click', async () => {
    if (await editAlertPlan(null, setStatus)) await refresh('alerts');
  });
  $('#btn-alert-run')?.addEventListener('click', async () => {
    const result = await post('/api/watch/run-once', { notify: false });
    setStatus(
      result.ok
        ? `预警计划试跑完成：${result.data.evaluatedPlans} 个计划，${result.data.triggers.length} 条触发`
        : errorText(result),
      !result.ok,
    );
    await refresh('alerts');
  });
};
