import { callApi } from './api.js';
import { $, el, mount } from './ui.js';

const errorText = (result) => {
  const error = result?.error;
  if (error === undefined) return '操作失败';
  return `${error.kind ?? 'error'}：${error.message ?? error.required ?? error.cause ?? '操作失败'}`;
};

const post = (path, input, method = 'POST') =>
  callApi(path, { method, body: JSON.stringify(input) });

/** 触发条目时间行；字段名与 WatchTriggerSchema（只有 createdAt）对齐。 */
export const triggerMetaText = (trigger) =>
  `${trigger.alertPlanId} · data ${new Date(trigger.createdAt).toLocaleString('zh-CN')}`;

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

let selectedStrategyId = '';
let selectedWatchlistId = '';

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
      setStatus(created.ok ? 'StrategyVersion 已创建' : errorText(created), !created.ok);
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
        setStatus(published.ok ? 'Strategy 已发布' : errorText(published), !published.ok);
        button.disabled = false;
        await renderStrategyDetail(strategy.id, setStatus);
      }),
      actionButton('样本 dry-run', async (button) => {
        button.disabled = true;
        const stockId = window.prompt('样本股票 ID', '600519.SH')?.trim();
        if (stockId === undefined || stockId.length === 0) {
          button.disabled = false;
          return;
        }
        const run = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/run`, {
          stockIds: [stockId],
          persist: false,
        });
        setStatus(
          run.ok
            ? `dry-run ${run.data.run.status}；结果 ${run.data.results.length} 条`
            : errorText(run),
          !run.ok,
        );
        button.disabled = false;
      }),
    );
  }
  const versionRows =
    versions.length === 0
      ? [el('p', 'placeholder', '尚无版本。')]
      : versions.map((version) =>
          el('div', 'entity-item', [
            el('strong', null, `v${version.version}`),
            el(
              'span',
              'muted',
              `${version.validationStatus}${version.publishedAt ? ' · 已发布' : ''}`,
            ),
            ...(version.validationErrors ?? []).map((message) =>
              el('div', 'status error', String(message)),
            ),
          ]),
        );
  mount(root, [
    el('h2', null, strategy.name),
    el('p', 'muted', `${strategy.status} · ${strategy.description}`),
    actions,
    el('h3', 'mt-4', '版本'),
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
      ? el('p', 'placeholder', '尚无 Strategy。')
      : strategies.map((strategy) => {
          const button = actionButton(`${strategy.name} · ${strategy.status}`, () =>
            renderStrategyDetail(strategy.id, setStatus),
          );
          button.classList.add('entity-item');
          return button;
        }),
  );
  if (selectedStrategyId.length > 0) await renderStrategyDetail(selectedStrategyId, setStatus);
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
  const add = actionButton('添加 manual 成员', async () => {
    const stockId = window.prompt('股票 ID', '600519.SH')?.trim();
    if (stockId === undefined || stockId.length === 0) return;
    const added = await post(`/api/watchlists/${encodeURIComponent(watchlist.id)}/members`, {
      stockId,
      reason: 'Web 手动加入',
    });
    setStatus(added.ok ? '成员已加入' : errorText(added), !added.ok);
    await renderWatchlistDetail(watchlist.id, setStatus);
  });
  const rows = members.map(({ member, sources }) => {
    const stage = document.createElement('select');
    for (const value of ['discovered', 'watching', 'researching', 'confirmed']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      option.selected = member.stage === value;
      stage.append(option);
    }
    stage.addEventListener('change', async () => {
      const updated = await post(
        `/api/watchlists/${encodeURIComponent(watchlist.id)}/members/${encodeURIComponent(member.stockId)}`,
        { stage: stage.value },
        'PATCH',
      );
      setStatus(updated.ok ? '研究阶段已更新' : errorText(updated), !updated.ok);
    });
    return el('div', 'entity-item', [
      el('strong', null, member.stockId),
      stage,
      el(
        'div',
        'muted',
        sources.map((source) => `${source.kind}:${source.status}`).join(' · ') || '无来源',
      ),
    ]);
  });
  mount(root, [
    el('h2', null, watchlist.name),
    el('p', 'muted', `${watchlist.kind} · ${watchlist.membershipPolicy}`),
    add,
    el('h3', 'mt-4', `成员 ${members.length}`),
    ...(rows.length === 0 ? [el('p', 'placeholder', '暂无成员。')] : rows),
    el('h3', 'mt-4', `AlertPlan ${alertPlans.length}`),
  ]);
};

export const renderWatchlists = async (setStatus) => {
  const result = await callApi('/api/watchlists');
  const list = $('#watchlists-list');
  if (list === null) return;
  if (!result.ok) {
    mount(list, el('p', 'status error', errorText(result)));
    return;
  }
  const items = result.data.items ?? [];
  const meta = $('#watchlists-meta');
  if (meta !== null) meta.textContent = `${items.length} 个`;
  mount(
    list,
    items.length === 0
      ? el('p', 'placeholder', '尚无 Watchlist。')
      : items.map(({ watchlist, memberCount, sourceHealth }) => {
          const button = actionButton(
            `${watchlist.name} · ${memberCount} 成员 · stale ${sourceHealth.stale}`,
            () => renderWatchlistDetail(watchlist.id, setStatus),
          );
          button.classList.add('entity-item');
          return button;
        }),
  );
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
              el('span', 'muted', `${plan.watchlistId} · ${plan.rules.length} rules`),
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

export const initTargetActions = ({ setStatus, refresh }) => {
  $('#btn-strategy-create')?.addEventListener('click', async () => {
    const name = window.prompt('Strategy 名称', '价格有效性 Strategy')?.trim();
    if (name === undefined || name.length === 0) return;
    const result = await post('/api/strategies', {
      name,
      description: '从 Web 模板创建，仅用于研究',
    });
    setStatus(result.ok ? 'Strategy 草案已创建' : errorText(result), !result.ok);
    if (result.ok) selectedStrategyId = result.data.strategy.id;
    await refresh('strategies');
  });
  $('#btn-watchlist-create')?.addEventListener('click', async () => {
    const name = window.prompt('Watchlist 名称', '研究候选')?.trim();
    if (name === undefined || name.length === 0) return;
    const result = await post('/api/watchlists', {
      name,
      kind: 'personal',
      membershipPolicy: 'mixed',
    });
    setStatus(result.ok ? 'Watchlist 已创建' : errorText(result), !result.ok);
    if (result.ok) selectedWatchlistId = result.data.watchlist.id;
    await refresh('watchlists');
  });
  $('#btn-alert-create')?.addEventListener('click', async () => {
    const watchlistId = window.prompt('引用的 Watchlist ID', selectedWatchlistId)?.trim();
    if (watchlistId === undefined || watchlistId.length === 0) return;
    const result = await post('/api/alert-plans', {
      name: `${watchlistId} 价格提醒`,
      watchlistId,
      rules: [{ id: 'price-level-1', kind: 'price-level', level: 1, side: 'above' }],
    });
    setStatus(result.ok ? 'AlertPlan 已创建' : errorText(result), !result.ok);
    await refresh('alerts');
  });
  $('#btn-alert-run')?.addEventListener('click', async () => {
    const result = await post('/api/watch/run-once', { notify: false });
    setStatus(
      result.ok
        ? `AlertPlan 试跑完成：${result.data.evaluatedPlans} plans，${result.data.triggers.length} triggers`
        : errorText(result),
      !result.ok,
    );
    await refresh('alerts');
  });
};
