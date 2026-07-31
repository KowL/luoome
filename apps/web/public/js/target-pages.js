import { callApi } from './api.js';
import { closeModal, confirmDialog, openModal, promptDialog } from './modal.js';
import { $, el, fmtDateTime, mount, statBlock } from './ui.js';

const errorText = (result) => {
  const error = result?.error;
  if (error === undefined) return '操作失败';
  return `${error.kind ?? 'error'}：${error.message ?? error.required ?? error.cause ?? '操作失败'}`;
};

const post = (path, input, method = 'POST') =>
  callApi(path, { method, body: JSON.stringify(input) });

/** 触发条目时间行；字段名与 WatchTriggerSchema（只有 createdAt）对齐。 */
export const triggerMetaText = (trigger) =>
  `${trigger.alertPlanId} · 数据 ${new Date(trigger.createdAt).toLocaleString('zh-CN')}`;

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

const STRATEGY_STATUS_TEXT = {
  active: '运行中',
  draft: '草稿',
  paused: '已暂停',
  archived: '已归档',
};

const strategyStatusBadge = (status) => {
  const variant =
    { active: 'badge-active', draft: 'badge-draft', paused: 'badge-paused' }[status] ??
    'badge-neutral';
  return el('span', `badge ${variant}`, STRATEGY_STATUS_TEXT[status] ?? status);
};

const VALIDATION_STATUS_TEXT = { valid: '有效', invalid: '无效', pending: '待校验' };

const validationStatusBadge = (status) => {
  const variant =
    { valid: 'badge-active', invalid: 'badge-pos', pending: 'badge-neutral' }[status] ??
    'badge-neutral';
  return el('span', `badge ${variant}`, VALIDATION_STATUS_TEXT[status] ?? status);
};

const STRATEGY_OWNER_TEXT = { builtin: '内置', user: '用户' };

const STRATEGY_STYLE_TEXT = {
  momentum: '动量',
  'mean-reversion': '均值回复',
  volume: '量能',
  risk: '风控',
  pattern: '形态',
};

const RUN_STATUS_TEXT = {
  running: '运行中',
  complete: '完成',
  partial: '部分完成',
  failed: '失败',
};

const WATCHLIST_KIND_TEXT = {
  personal: '个人',
  strategy: '策略',
  portfolio: '持仓',
  system: '系统',
};

const MEMBERSHIP_POLICY_TEXT = { manual: '手动', synced: '同步', mixed: '混合' };

const MEMBER_STAGE_TEXT = {
  discovered: '已发现',
  watching: '观察中',
  researching: '研究中',
  confirmed: '已确认',
};

const MEMBER_SOURCE_KIND_TEXT = {
  manual: '手动',
  strategy: '策略',
  ai: 'AI',
  portfolio: '持仓',
  import: '导入',
};

const MEMBER_SOURCE_STATUS_TEXT = { active: '活跃', stale: '过期', ended: '结束' };

const MEMBER_PRIORITY_TEXT = { normal: '普通', important: '重要', urgent: '紧急' };

const RULE_KIND_TEXT = {
  tactic: '战法',
  'strategy-signal': '策略信号',
  'cost-threshold': '成本阈值',
  'price-change': '涨跌幅',
  'price-level': '价格位',
  'event-date': '事件日期',
};

const priorityBadge = (priority) => {
  const variant =
    { urgent: 'badge-urgent', important: 'badge-important', normal: 'badge-normal' }[priority] ??
    'badge-neutral';
  return el('span', `badge ${variant}`, MEMBER_PRIORITY_TEXT[priority] ?? priority);
};

const DIRECTION_TEXT = { bullish: '看多', bearish: '看空', neutral: '中性' };

const directionBadge = (direction) => {
  const variant = { bullish: 'badge-pos', bearish: 'badge-neg' }[direction] ?? 'badge-neutral';
  return el('span', `badge ${variant}`, DIRECTION_TEXT[direction] ?? direction);
};

/** 从 run_strategy 返回的 signals 汇总逐股命中：同股取最高分，按分数降序。 */
export const extractRunHits = (signals) => {
  const byStock = new Map();
  for (const signal of signals ?? []) {
    const prev = byStock.get(signal.stockId);
    if (prev === undefined || Number(signal.score) > prev.score) {
      byStock.set(signal.stockId, {
        stockId: signal.stockId,
        score: Number(signal.score),
        direction: signal.direction,
      });
    }
  }
  return [...byStock.values()].sort((a, b) => b.score - a.score);
};

/** 最近一次运行（试跑或正式）的命中结果，随详情面板重绘保留。 */
let lastRunHits = { strategyId: '', items: [] };

let selectedStrategyId = '';
let selectedWatchlistId = '';

/** 最近运行命中区块：逐股命中 + 目标关注列表下拉 + 一键加入。 */
const renderRunHits = async (strategy, setStatus) => {
  if (lastRunHits.strategyId !== strategy.id || lastRunHits.items.length === 0) return [];
  const watchlistsResult = await callApi('/api/watchlists');
  const watchlistItems = watchlistsResult.ok ? (watchlistsResult.data.items ?? []) : [];
  const header = el('h3', 'mt-4', `最近运行命中 ${lastRunHits.items.length}`);
  if (watchlistItems.length === 0) {
    return [header, el('p', 'placeholder', '暂无关注列表，请先创建。')];
  }
  const select = document.createElement('select');
  for (const { watchlist } of watchlistItems) {
    const option = document.createElement('option');
    option.value = watchlist.id;
    option.textContent = watchlist.name;
    select.append(option);
  }
  return [
    header,
    el('div', 'flex gap-2', [el('span', 'muted', '目标关注列表'), select]),
    ...lastRunHits.items.map((hit) =>
      el('div', 'entity-item', [
        el('div', 'flex gap-2', [
          el('strong', null, hit.stockId),
          directionBadge(hit.direction),
          el('span', 'muted', `score ${hit.score}`),
        ]),
        actionButton('加入关注列表', async (button) => {
          button.disabled = true;
          const added = await post(`/api/watchlists/${encodeURIComponent(select.value)}/members`, {
            stockId: hit.stockId,
            reason: `策略「${strategy.name}」信号（score ${hit.score}）`,
          });
          setStatus(added.ok ? `${hit.stockId} 已加入关注列表` : errorText(added), !added.ok);
          button.disabled = false;
        }),
      ]),
    ),
  ];
};

const renderStrategyDetail = async (strategyId, setStatus) => {
  selectedStrategyId = strategyId;
  const result = await callApi(`/api/strategies/${encodeURIComponent(strategyId)}`);
  const root = $('#strategy-detail');
  if (root === null) return;
  if (!result.ok) {
    mount(root, el('p', 'status error', errorText(result)));
    return;
  }
  const { strategy, versions } = result.data;
  const latest = versions.at(-1);
  const actions = el('div', 'flex gap-2');
  actions.append(
    actionButton('创建模板版本', async (button) => {
      button.disabled = true;
      const created = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/versions`, {
        definition: templateDefinition,
        changeSummary: 'Web 模板版本',
      });
      setStatus(created.ok ? '策略版本已创建' : errorText(created), !created.ok);
      button.disabled = false;
      await renderStrategyDetail(strategy.id, setStatus);
    }),
  );
  if (latest !== undefined) {
    actions.append(
      actionButton('校验', async (button) => {
        button.disabled = true;
        const checked = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/validate`, {
          versionId: latest.id,
        });
        setStatus(checked.ok ? '校验完成' : errorText(checked), !checked.ok);
        button.disabled = false;
        await renderStrategyDetail(strategy.id, setStatus);
      }),
      actionButton('发布', async (button) => {
        button.disabled = true;
        const published = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/publish`, {
          versionId: latest.id,
        });
        setStatus(published.ok ? '策略已发布' : errorText(published), !published.ok);
        button.disabled = false;
        await renderStrategyDetail(strategy.id, setStatus);
      }),
      actionButton('样本试跑', async (button) => {
        const values = await promptDialog({
          title: '样本试跑',
          fields: [{ key: 'stockId', label: '样本股票代码', value: '600519.SH' }],
          confirmLabel: '试跑',
        });
        const stockId = values?.stockId;
        if (stockId === undefined || stockId.length === 0) return;
        button.disabled = true;
        const run = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/run`, {
          stockIds: [stockId],
          persist: false,
        });
        if (run.ok) {
          lastRunHits = { strategyId: strategy.id, items: extractRunHits(run.data.signals) };
          setStatus(
            `试跑${RUN_STATUS_TEXT[run.data.run.status] ?? run.data.run.status}；结果 ${run.data.results.length} 条`,
          );
        } else {
          setStatus(errorText(run), true);
        }
        button.disabled = false;
        await renderStrategyDetail(strategy.id, setStatus);
      }),
      actionButton('正式运行', async (button) => {
        const confirmed = await confirmDialog({
          title: '正式运行',
          message: '全市场扫描并落库，耗时较长，确认运行？',
          confirmLabel: '运行',
        });
        if (!confirmed) return;
        button.disabled = true;
        const run = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/run`, {
          persist: true,
        });
        if (run.ok) {
          lastRunHits = { strategyId: strategy.id, items: extractRunHits(run.data.signals) };
          setStatus(
            `运行${RUN_STATUS_TEXT[run.data.run.status] ?? run.data.run.status}；信号 ${run.data.signals.length} 条，已落库`,
          );
        } else {
          setStatus(errorText(run), true);
        }
        button.disabled = false;
        await renderStrategyDetail(strategy.id, setStatus);
      }),
    );
  }
  const hitsBlock = await renderRunHits(strategy, setStatus);
  const versionRows =
    versions.length === 0
      ? [el('p', 'placeholder', '尚无版本。')]
      : versions.map((version) =>
          el('div', 'entity-item', [
            el('div', 'flex gap-2', [
              el('strong', null, `v${version.version}`),
              validationStatusBadge(version.validationStatus),
              ...(version.publishedAt ? [el('span', 'badge badge-active', '已发布')] : []),
            ]),
            el(
              'div',
              'muted',
              `${version.changeSummary} · ${new Date(version.createdAt).toLocaleString('zh-CN')}`,
            ),
            ...(version.validationErrors ?? []).map((message) =>
              el('div', 'status error', String(message)),
            ),
          ]),
        );
  mount(root, [
    el('div', 'flex gap-2', [el('h2', null, strategy.name), strategyStatusBadge(strategy.status)]),
    el(
      'p',
      'muted',
      `${STRATEGY_OWNER_TEXT[strategy.owner] ?? strategy.owner} · ${strategy.description}`,
    ),
    actions,
    ...hitsBlock,
    el('h3', 'mt-4', `版本 ${versions.length}`),
    ...versionRows,
  ]);
};

export const renderStrategies = async (setStatus) => {
  const result = await callApi('/api/strategies');
  const list = $('#strategies-list');
  if (list === null) return;
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
      ? el('p', 'placeholder', '尚无策略。')
      : strategies.map((strategy) => {
          const button = el('button', 'entity-row', [
            el('span', 'entity-row-main', [
              el('strong', null, strategy.name),
              el('small', null, strategy.description),
            ]),
            strategyStatusBadge(strategy.status),
          ]);
          button.type = 'button';
          if (strategy.id === selectedStrategyId) button.classList.add('selected');
          button.addEventListener('click', () => void renderStrategyDetail(strategy.id, setStatus));
          return button;
        }),
  );
  if (selectedStrategyId.length > 0) await renderStrategyDetail(selectedStrategyId, setStatus);
};

/**
 * 六种视图（PRD §10.1）的行数据：全部从 /api/watchlists/overview 一次拉取的数据派生，
 * 切换视图不重复请求。
 */
export const deriveWatchlistViews = (overview) => {
  const listCards = (overview?.lists ?? []).map((row) => ({
    watchlist: row.watchlist,
    memberCount: row.memberCount ?? 0,
    discoveredCount: row.discoveredCount ?? 0,
    staleSources: row.sourceHealth?.stale ?? 0,
    todayEntered: row.todayEntered ?? 0,
    todayExited: row.todayExited ?? 0,
  }));
  const stocks = [...(overview?.stocks ?? [])].sort((a, b) => a.stockId.localeCompare(b.stockId));
  const todayChanges = [...(overview?.todayChanges ?? [])].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );
  const pending = [];
  const holdings = [];
  for (const stock of stocks) {
    const memberships = stock.memberships ?? [];
    if (memberships.some((membership) => membership.holding)) holdings.push(stock);
    for (const membership of memberships) {
      if (membership.stage !== 'discovered') continue;
      pending.push({
        watchlistId: membership.watchlistId,
        watchlistName: membership.watchlistName,
        stockId: stock.stockId,
        priority: membership.priority,
      });
    }
  }
  return {
    listCards,
    stocks,
    todayChanges,
    pending,
    holdings,
    archived: {
      lists: overview?.archived?.lists ?? [],
      members: overview?.archived?.members ?? [],
    },
  };
};

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

const WATCHLIST_VIEW_TABS = [
  { key: 'byList', label: '按列表' },
  { key: 'stocks', label: '全部股票' },
  { key: 'today', label: '今日变化' },
  { key: 'pending', label: '待研究' },
  { key: 'holdings', label: '当前持仓' },
  { key: 'archived', label: '已归档' },
];

/** 当前总览 tab 与最近一次 overview 数据：切换 tab 由前端派生，不重复拉取。 */
let watchlistView = 'byList';
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

const renderByListView = (views, setStatus) =>
  views.listCards.length === 0
    ? [el('p', 'placeholder', '尚无关注列表。')]
    : views.listCards.map((card) => {
        const button = el('button', 'entity-row', [
          el('span', 'entity-row-main', [
            el('strong', null, card.watchlist.name),
            el(
              'small',
              null,
              `${card.memberCount} 成员 · 待研究 ${card.discoveredCount} · 过期来源 ${card.staleSources} · 今日 +${card.todayEntered}/-${card.todayExited}`,
            ),
          ]),
          el('span', 'flex gap-2', [
            el(
              'span',
              'badge badge-neutral',
              WATCHLIST_KIND_TEXT[card.watchlist.kind] ?? card.watchlist.kind,
            ),
            ...(card.watchlist.enabled ? [] : [el('span', 'badge badge-paused', '停用')]),
          ]),
        ]);
        button.type = 'button';
        if (card.watchlist.id === selectedWatchlistId) button.classList.add('selected');
        button.addEventListener(
          'click',
          () => void renderWatchlistDetail(card.watchlist.id, setStatus),
        );
        return button;
      });

const renderStocksView = (views) =>
  views.stocks.length === 0
    ? [el('p', 'placeholder', '暂无成员股票。')]
    : views.stocks.map((stock) =>
        el('div', 'entity-item', [
          el('div', 'flex gap-2', [
            el('strong', null, stock.stockId),
            ...(stock.memberships.some((membership) => membership.holding)
              ? [el('span', 'badge badge-holding', '持仓')]
              : []),
          ]),
          el(
            'div',
            'muted',
            stock.memberships.map((membership) => membership.watchlistName).join(' · '),
          ),
          el(
            'div',
            'flex gap-2',
            stock.memberships.map((membership) =>
              el(
                'span',
                'badge badge-neutral',
                `${MEMBER_STAGE_TEXT[membership.stage] ?? membership.stage}·${MEMBER_PRIORITY_TEXT[membership.priority] ?? membership.priority}`,
              ),
            ),
          ),
        ]),
      );

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

const renderPendingView = (views, setStatus) =>
  views.pending.length === 0
    ? [el('p', 'placeholder', '暂无待研究成员。')]
    : views.pending.map((item) =>
        el('div', 'entity-item', [
          el('div', 'flex gap-2', [
            el('strong', null, item.stockId),
            priorityBadge(item.priority),
            el('span', 'muted', item.watchlistName),
          ]),
          el('div', 'flex gap-2', [
            actionButton('开始研究', async (button) => {
              button.disabled = true;
              const updated = await patchMember(item.watchlistId, item.stockId, {
                stage: 'researching',
              });
              setStatus(
                updated.ok ? `${item.stockId} 已开始研究` : errorText(updated),
                !updated.ok,
              );
              await renderWatchlists(setStatus);
            }),
            actionButton('归档', async (button) => {
              button.disabled = true;
              const archived = await archiveMember(item.watchlistId, item.stockId);
              setStatus(archived.ok ? `${item.stockId} 已归档` : errorText(archived), !archived.ok);
              await renderWatchlists(setStatus);
            }),
          ]),
        ]),
      );

const renderHoldingsView = (views) =>
  views.holdings.length === 0
    ? [el('p', 'placeholder', '暂无持仓成员。')]
    : views.holdings.map((stock) =>
        el('div', 'entity-item', [
          el('div', 'flex gap-2', [
            el('strong', null, stock.stockId),
            el('span', 'badge badge-holding', '持仓'),
          ]),
          el(
            'div',
            'muted',
            stock.memberships
              .map(
                (membership) =>
                  `${membership.watchlistName}（${MEMBER_STAGE_TEXT[membership.stage] ?? membership.stage}）`,
              )
              .join(' · '),
          ),
        ]),
      );

const renderArchivedView = (views) => [
  el('p', 'muted', '列表归档即停用，成员与历史保留。'),
  el('h3', null, `已归档列表 ${views.archived.lists.length}`),
  ...(views.archived.lists.length === 0
    ? [el('p', 'placeholder', '暂无已归档列表。')]
    : views.archived.lists.map((watchlist) =>
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
  el('h3', 'mt-4', `已归档成员 ${views.archived.members.length}`),
  ...(views.archived.members.length === 0
    ? [el('p', 'placeholder', '暂无已归档成员。')]
    : views.archived.members.map((item) =>
        el('div', 'entity-item', [
          el('strong', null, `${item.watchlistName} · ${item.member.stockId}`),
          el('div', 'muted', `归档于 ${fmtDateTime(item.member.archivedAt)}`),
        ]),
      )),
];

const renderWatchlistOverview = (setStatus) => {
  const overview = lastWatchlistOverview;
  if (overview === null) return;
  const views = deriveWatchlistViews(overview);
  const summary = $('#watchlists-summary');
  if (summary !== null) {
    const sum = (pick) => views.listCards.reduce((total, card) => total + pick(card), 0);
    mount(summary, [
      statBlock('关注列表', String(views.listCards.length)),
      statBlock('成员', String(sum((card) => card.memberCount))),
      statBlock(
        '今日变化',
        `+${sum((card) => card.todayEntered)} / -${sum((card) => card.todayExited)}`,
      ),
      statBlock('待研究', String(views.pending.length)),
      statBlock('过期来源', String(sum((card) => card.staleSources))),
      statBlock('紧急/重要触发', String(overview.triggers?.urgentImportantCount ?? 0)),
    ]);
  }
  const tabs = $('#watchlists-tabs');
  if (tabs !== null) {
    mount(
      tabs,
      WATCHLIST_VIEW_TABS.map((tab) => {
        const button = el(
          'button',
          `btn btn-sm ${tab.key === watchlistView ? 'btn-primary' : 'btn-outline'}`,
          tab.label,
        );
        button.type = 'button';
        button.addEventListener('click', () => {
          watchlistView = tab.key;
          renderWatchlistOverview(setStatus);
        });
        return button;
      }),
    );
  }
  const meta = $('#watchlists-meta');
  if (meta !== null) {
    meta.textContent = `${views.listCards.length} 个列表 · ${views.stocks.length} 只股票`;
  }
  const view = $('#watchlists-view');
  if (view === null) return;
  const content =
    watchlistView === 'stocks'
      ? renderStocksView(views)
      : watchlistView === 'today'
        ? renderTodayView(views)
        : watchlistView === 'pending'
          ? renderPendingView(views, setStatus)
          : watchlistView === 'holdings'
            ? renderHoldingsView(views)
            : watchlistView === 'archived'
              ? renderArchivedView(views)
              : renderByListView(views, setStatus);
  mount(view, content);
};

const renderWatchlistDetail = async (watchlistId, setStatus) => {
  selectedWatchlistId = watchlistId;
  const result = await callApi(`/api/watchlists/${encodeURIComponent(watchlistId)}`);
  const root = $('#watchlist-detail');
  if (root === null) return;
  if (!result.ok) {
    mount(root, el('p', 'status error', errorText(result)));
    return;
  }
  const { watchlist, members, alertPlans } = result.data;

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
    selectedWatchlistId = '';
    setStatus('关注列表已归档');
    mount(root, el('p', 'placeholder', '选择关注列表查看成员和来源。'));
    await renderWatchlists(setStatus);
  });

  const add = actionButton('手动添加成员', async () => {
    const values = await promptDialog({
      title: '手动添加成员',
      fields: [
        { key: 'stockId', label: '股票代码', value: '600519.SH' },
        { key: 'reason', label: '加入原因（可空，默认「用户手工添加」）', value: '' },
      ],
      confirmLabel: '添加',
    });
    const stockId = values?.stockId;
    if (stockId === undefined || stockId.length === 0) return;
    const input = { stockId };
    if ((values.reason ?? '').length > 0) input.reason = values.reason;
    const added = await post(`/api/watchlists/${encodeURIComponent(watchlist.id)}/members`, input);
    setStatus(added.ok ? '成员已加入' : errorText(added), !added.ok);
    await renderWatchlists(setStatus);
  });

  const health = summarizeMemberSources(members.flatMap(({ sources }) => sources));
  const latestByStock = lastWatchlistOverview?.triggers?.latestByStock ?? {};

  const rows = members.map(({ member, sources }) => {
    const stage = memberSelect(
      ['discovered', 'watching', 'researching', 'confirmed'],
      member.stage,
      MEMBER_STAGE_TEXT,
    );
    stage.addEventListener('change', async () => {
      const updated = await patchMember(watchlist.id, member.stockId, { stage: stage.value });
      setStatus(updated.ok ? '研究阶段已更新' : errorText(updated), !updated.ok);
    });
    const priority = memberSelect(
      ['normal', 'important', 'urgent'],
      member.priority,
      MEMBER_PRIORITY_TEXT,
    );
    priority.addEventListener('change', async () => {
      const updated = await patchMember(watchlist.id, member.stockId, {
        priority: priority.value,
      });
      setStatus(updated.ok ? '优先级已更新' : errorText(updated), !updated.ok);
    });
    const trigger = latestByStock[member.stockId];
    return el('div', 'entity-item', [
      el('div', 'flex gap-2', [el('strong', null, member.stockId), stage, priority]),
      el(
        'div',
        'flex gap-2',
        sources.length === 0
          ? [el('span', 'muted', '无来源')]
          : sources.map((source) =>
              el(
                'span',
                'badge badge-neutral',
                `${MEMBER_SOURCE_KIND_TEXT[source.kind] ?? source.kind}·${MEMBER_SOURCE_STATUS_TEXT[source.status] ?? source.status}${source.dataAsOf ? `·${fmtDateTime(source.dataAsOf)}` : ''}`,
              ),
            ),
      ),
      ...(trigger === undefined
        ? []
        : [
            el(
              'div',
              'muted',
              `最近触发：${RULE_KIND_TEXT[trigger.ruleKind] ?? trigger.ruleKind} · ${MEMBER_PRIORITY_TEXT[trigger.priority] ?? trigger.priority} · ${fmtDateTime(trigger.at)}`,
            ),
          ]),
      actionButton('归档', async (button) => {
        button.disabled = true;
        const archived = await archiveMember(watchlist.id, member.stockId);
        setStatus(archived.ok ? `${member.stockId} 已归档` : errorText(archived), !archived.ok);
        await renderWatchlists(setStatus);
      }),
    ]);
  });

  mount(root, [
    el('div', 'flex gap-2', [
      el('h2', null, watchlist.name),
      ...(watchlist.enabled ? [] : [el('span', 'badge badge-paused', '停用')]),
    ]),
    el(
      'p',
      'muted',
      `${WATCHLIST_KIND_TEXT[watchlist.kind] ?? watchlist.kind} · ${MEMBERSHIP_POLICY_TEXT[watchlist.membershipPolicy] ?? watchlist.membershipPolicy}${watchlist.description ? ` · ${watchlist.description}` : ''}`,
    ),
    el(
      'p',
      'muted',
      `来源健康：活跃 ${health.active} · 过期 ${health.stale}${health.latestDataAsOf === null ? '' : ` · 最近数据 ${fmtDateTime(health.latestDataAsOf)}`}`,
    ),
    el('div', 'flex gap-2', [edit, archiveList, add]),
    el('h3', 'mt-4', `成员 ${members.length}`),
    ...(rows.length === 0 ? [el('p', 'placeholder', '暂无成员。')] : rows),
    el('h3', 'mt-4', `预警计划 ${alertPlans.length}`),
    ...(alertPlans.length === 0
      ? [el('p', 'placeholder', '暂无预警计划。')]
      : alertPlans.map((plan) => {
          const row = el('button', 'entity-row', [
            el('span', 'entity-row-main', [
              el('strong', null, plan.name),
              el(
                'small',
                null,
                `${plan.rules.length} 条规则：${[...new Set(plan.rules.map((rule) => RULE_KIND_TEXT[rule.kind] ?? rule.kind))].join('、')}`,
              ),
            ]),
            el(
              'span',
              `badge ${plan.enabled ? 'badge-active' : 'badge-neutral'}`,
              plan.enabled ? '启用' : '停用',
            ),
          ]);
          row.type = 'button';
          row.addEventListener('click', () => {
            window.location.hash = '#alerts';
          });
          return row;
        })),
  ]);
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
  if (selectedWatchlistId.length > 0) await renderWatchlistDetail(selectedWatchlistId, setStatus);
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
    mount(
      plansRoot,
      plansResult.ok
        ? plans.map((plan) =>
            el('div', 'entity-item', [
              el('strong', null, plan.name),
              el('span', 'muted', `${plan.watchlistId} · ${plan.rules.length} 条规则`),
            ]),
          )
        : el('p', 'status error', errorText(plansResult)),
    );
  }
  if (triggersRoot !== null) {
    const triggers = triggersResult.ok ? (triggersResult.data.triggers ?? []) : [];
    mount(
      triggersRoot,
      triggersResult.ok
        ? triggers.map((trigger) =>
            el('div', 'entity-item', [
              el('strong', null, `${trigger.stockId} · ${trigger.ruleKind}`),
              el('div', 'muted', triggerMetaText(trigger)),
              el('div', null, (trigger.evidence ?? []).join('；')),
            ]),
          )
        : el('p', 'status error', errorText(triggersResult)),
    );
  }
  void setStatus;
};

const openStrategyCreateModal = (setStatus, refresh) => {
  let mode = 'custom';
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.placeholder = '策略名称';
  const descInput = el('input');
  descInput.type = 'text';
  descInput.placeholder = '策略描述';
  const defInput = el('textarea');
  defInput.rows = 16;
  defInput.spellcheck = false;
  defInput.value = JSON.stringify(templateDefinition, null, 2);
  const customSection = el('div', null, [
    el('p', 'hint', '策略定义（JSON，DSL v1；selection 至少一条规则，scoring 权重之和为 1）'),
    defInput,
  ]);
  const templateSection = el('div', null, [el('p', 'placeholder', '加载模板中…')]);
  templateSection.hidden = true;

  let templatesLoaded = false;
  let selectedTemplate = null;
  const loadTemplates = async () => {
    templatesLoaded = true;
    const result = await callApi('/api/strategy-templates');
    if (!result.ok) {
      mount(templateSection, el('p', 'status error', errorText(result)));
      return;
    }
    const templates = result.data.templates ?? [];
    if (templates.length === 0) {
      mount(templateSection, el('p', 'placeholder', '暂无可用模板'));
      return;
    }
    selectedTemplate = templates[0];
    nameInput.value = selectedTemplate.name;
    descInput.value = selectedTemplate.description;
    const cards = templates.map((template) => {
      const card = el('button', 'entity-row', [
        el('span', 'entity-row-main', [
          el('strong', null, template.name),
          el('small', null, template.description),
        ]),
        el(
          'span',
          'badge badge-neutral',
          STRATEGY_STYLE_TEXT[template.definition?.metadata?.style] ?? '模板',
        ),
      ]);
      card.type = 'button';
      if (template.id === selectedTemplate.id) card.classList.add('selected');
      card.addEventListener('click', () => {
        selectedTemplate = template;
        nameInput.value = template.name;
        descInput.value = template.description;
        for (const other of cards) other.classList.toggle('selected', other === card);
      });
      return card;
    });
    mount(templateSection, el('div', 'entity-list', cards));
  };

  const modeCustomBtn = el('button', 'btn btn-primary btn-sm', '自定义策略');
  const modeTemplateBtn = el('button', 'btn btn-outline btn-sm', '从模板导入');
  modeCustomBtn.type = 'button';
  modeTemplateBtn.type = 'button';
  const switchMode = (next) => {
    mode = next;
    modeCustomBtn.className = `btn btn-sm ${next === 'custom' ? 'btn-primary' : 'btn-outline'}`;
    modeTemplateBtn.className = `btn btn-sm ${next === 'template' ? 'btn-primary' : 'btn-outline'}`;
    customSection.hidden = next !== 'custom';
    templateSection.hidden = next !== 'template';
    if (next === 'template' && !templatesLoaded) void loadTemplates();
  };
  modeCustomBtn.addEventListener('click', () => switchMode('custom'));
  modeTemplateBtn.addEventListener('click', () => switchMode('template'));

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
      let changeSummary;
      if (mode === 'custom') {
        try {
          definition = JSON.parse(defInput.value);
        } catch {
          setStatus('策略定义不是合法 JSON', true);
          return;
        }
        changeSummary = '自定义创建';
      } else {
        if (selectedTemplate === null) {
          setStatus('请选择模板', true);
          return;
        }
        definition = selectedTemplate.definition;
        changeSummary = `从模板「${selectedTemplate.name}」创建`;
      }
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
      setStatus(mode === 'custom' ? '策略已创建' : '策略已从模板创建');
      await refresh('strategies');
    },
    true,
  );
  openModal(
    '新增策略',
    el('div', null, [
      el('div', 'flex gap-2', [modeCustomBtn, modeTemplateBtn]),
      el('p', 'hint', '名称'),
      nameInput,
      el('p', 'hint', '描述'),
      descInput,
      customSection,
      templateSection,
      el('div', 'modal-actions', [submit]),
    ]),
  );
};

export const initTargetActions = ({ setStatus, refresh }) => {
  $('#btn-strategy-create')?.addEventListener('click', () =>
    openStrategyCreateModal(setStatus, refresh),
  );
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
    if (result.ok) selectedWatchlistId = result.data.watchlist.id;
    await refresh('watchlists');
  });
  $('#btn-alert-create')?.addEventListener('click', async () => {
    const values = await promptDialog({
      title: '新建预警计划',
      fields: [{ key: 'watchlistId', label: '引用的关注列表 ID', value: selectedWatchlistId }],
      confirmLabel: '创建',
    });
    const watchlistId = values?.watchlistId;
    if (watchlistId === undefined || watchlistId.length === 0) return;
    const result = await post('/api/alert-plans', {
      name: `${watchlistId} 价格提醒`,
      watchlistId,
      rules: [{ id: 'price-level-1', kind: 'price-level', level: 1, side: 'above' }],
    });
    setStatus(result.ok ? '预警计划已创建' : errorText(result), !result.ok);
    await refresh('alerts');
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
