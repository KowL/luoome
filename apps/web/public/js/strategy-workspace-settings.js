import { makeInput, makeSelect } from './form-kit.js';
import { createStrategyDefinitionEditor } from './strategy-workspace-experiment.js';
import {
  badge,
  callApi,
  closeModal,
  confirmDialog,
  createFeatureCache,
  el,
  errorText,
  fmtDateTime,
  openModal,
  post,
} from './strategy-workspace-shared.js';

const featureCache = createFeatureCache();
const { cachedGet } = featureCache;
export const invalidateSettingsCache = () => featureCache.clear();

const openVersionEditor = async (strategy, latest, setStatus, refresh) => {
  const catalogResult = await cachedGet('/api/strategy/dsl-catalog');
  if (!catalogResult.ok) {
    setStatus(errorText(catalogResult), true);
    return;
  }
  const editor = createStrategyDefinitionEditor(latest?.definition, catalogResult.data);
  const formError = el('p', 'status error');
  const summary = makeInput('strategy-version-summary', { placeholder: '说明本次规则变化' });
  const submit = el('button', 'btn btn-primary', '创建草案');
  submit.type = 'button';
  submit.addEventListener('click', async () => {
    let definition;
    try {
      definition = editor.getValue();
    } catch (error) {
      formError.textContent = error.message;
      return;
    }
    submit.disabled = true;
    const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/versions`, {
      definition,
      changeSummary: summary.value.trim() || 'Web 创建版本草案',
    });
    submit.disabled = false;
    if (!result.ok) {
      formError.textContent = errorText(result);
      return;
    }
    closeModal();
    featureCache.clear();
    setStatus(`v${result.data.version.version} 草案已创建`);
    await refresh();
  });
  openModal(
    `新版本草案 · ${strategy.name}`,
    el('div', 'modal-form', [
      el('p', 'hint', '发布版本不可原地修改；保存会创建新的不可变版本草案。'),
      summary,
      editor.root,
      formError,
      el('div', 'modal-actions', [submit]),
    ]),
  );
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
  const select = makeSelect(
    'strategy-watchlist-subscribe-target',
    targets.map(({ watchlist }) => [watchlist.id, `${watchlist.name} · ${watchlist.id}`]),
  );
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
    featureCache.clear();
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
        message: `确认停止将 ${strategy.name} 的后续 published operational run 同步到“${target?.name ?? subscription.watchlistId}”？已有 Watchlist 成员和同步历史不会被删除。`,
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
      featureCache.clear();
      setStatus('Strategy→Watchlist 订阅已取消');
      await refresh();
    });
    return el('article', 'entity-item', [
      el('div', 'flex gap-2', [
        el('strong', null, target?.name ?? subscription.watchlistId),
        el('span', 'badge badge-active', '同步中'),
      ]),
      el(
        'p',
        'muted',
        `source ${subscription.sourceKey} · 创建于 ${fmtDateTime(subscription.createdAt)}`,
      ),
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
  const result = await cachedGet(`/api/strategies/${encodeURIComponent(strategyId)}`);
  if (!result.ok) return el('p', 'status error', errorText(result));
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
      featureCache.clear();
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
        featureCache.clear();
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
      featureCache.clear();
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
      message: `确认删除“${strategy.name}”？版本、运行结果、信号和观察数据都会一并删除，且无法撤销。`,
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
    featureCache.clear();
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
  ]);
};
