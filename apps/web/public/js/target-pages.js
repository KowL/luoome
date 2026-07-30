import { callApi } from './api.js';
import { closeModal, confirmDialog, openModal, promptDialog } from './modal.js';
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
  strategy: '策略',
  ai: 'AI',
  portfolio: '持仓',
  import: '导入',
};

const MEMBER_SOURCE_STATUS_TEXT = { active: '活跃', stale: '过期', ended: '结束' };

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
  const add = actionButton('手动添加成员', async () => {
    const values = await promptDialog({
      title: '手动添加成员',
      fields: [{ key: 'stockId', label: '股票代码', value: '600519.SH' }],
      confirmLabel: '添加',
    });
    const stockId = values?.stockId;
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
      option.textContent = MEMBER_STAGE_TEXT[value] ?? value;
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
        sources
          .map(
            (source) =>
              `${MEMBER_SOURCE_KIND_TEXT[source.kind] ?? source.kind}：${MEMBER_SOURCE_STATUS_TEXT[source.status] ?? source.status}`,
          )
          .join(' · ') || '无来源',
      ),
    ]);
  });
  mount(root, [
    el('h2', null, watchlist.name),
    el(
      'p',
      'muted',
      `${WATCHLIST_KIND_TEXT[watchlist.kind] ?? watchlist.kind} · ${MEMBERSHIP_POLICY_TEXT[watchlist.membershipPolicy] ?? watchlist.membershipPolicy}`,
    ),
    add,
    el('h3', 'mt-4', `成员 ${members.length}`),
    ...(rows.length === 0 ? [el('p', 'placeholder', '暂无成员。')] : rows),
    el('h3', 'mt-4', `预警计划 ${alertPlans.length}`),
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
      ? el('p', 'placeholder', '尚无关注列表。')
      : items.map(({ watchlist, memberCount, sourceHealth }) => {
          const button = actionButton(
            `${watchlist.name} · ${memberCount} 成员 · 过期来源 ${sourceHealth.stale}`,
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

const openTemplateModal = async (setStatus, refresh) => {
  const result = await callApi('/api/strategy-templates');
  if (!result.ok) {
    setStatus(errorText(result), true);
    return;
  }
  const templates = result.data.templates ?? [];
  if (templates.length === 0) {
    setStatus('暂无可用模板', true);
    return;
  }
  let selected = templates[0];
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.value = selected.name;
  const descInput = el('input');
  descInput.type = 'text';
  descInput.value = selected.description;
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
    if (template.id === selected.id) card.classList.add('selected');
    card.addEventListener('click', () => {
      selected = template;
      nameInput.value = template.name;
      descInput.value = template.description;
      for (const other of cards) other.classList.toggle('selected', other === card);
    });
    return card;
  });
  const submit = actionButton(
    '创建',
    async (button) => {
      const name = nameInput.value.trim();
      if (name.length === 0) {
        setStatus('请输入策略名称', true);
        return;
      }
      button.disabled = true;
      const created = await post('/api/strategies', {
        name,
        description: descInput.value.trim() || selected.description,
      });
      if (!created.ok) {
        setStatus(errorText(created), true);
        button.disabled = false;
        return;
      }
      const versioned = await post(
        `/api/strategies/${encodeURIComponent(created.data.strategy.id)}/versions`,
        { definition: selected.definition, changeSummary: `从模板「${selected.name}」创建` },
      );
      button.disabled = false;
      if (!versioned.ok) {
        setStatus(errorText(versioned), true);
        return;
      }
      closeModal();
      selectedStrategyId = created.data.strategy.id;
      setStatus('策略已从模板创建');
      await refresh('strategies');
    },
    true,
  );
  openModal(
    '从模板创建策略',
    el('div', null, [
      el('div', 'entity-list', cards),
      el('p', 'hint', '名称'),
      nameInput,
      el('p', 'hint', '描述'),
      descInput,
      el('div', 'modal-actions', [submit]),
    ]),
  );
};

export const initTargetActions = ({ setStatus, refresh }) => {
  $('#btn-strategy-create')?.addEventListener(
    'click',
    () => void openTemplateModal(setStatus, refresh),
  );
  $('#btn-watchlist-create')?.addEventListener('click', async () => {
    const values = await promptDialog({
      title: '新建关注列表',
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
