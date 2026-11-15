import { callApi } from './api.js';
import { $, el } from './ui.js';

const groups = { provider: '数据提供者', task: '自动任务与采集', business: '业务能力' };
const phases = {
  ready: '已就绪',
  disabled: '已停用',
  blocked: '依赖阻断',
  draining: '排空中',
  failed: '资源应用失败',
};
let current = null;
let pending = null;
let busy = false;
let loading = false;
let generation = 0;
let initialized = false;
let reportStatus = () => {};
const version = (view) =>
  JSON.stringify([
    view.configuration.state,
    view.configuration.incarnation,
    view.configuration.revision,
    view.plugins.map((row) => [
      row.id,
      row.selectedRoutes,
      row.contributions.map((item) => [item.name, item.effect]),
    ]),
  ]);
const status = (text, error = false) => {
  const node = $('#plugin-settings-status');
  node.textContent = text;
  node.classList.toggle('error', error);
};
const command = (id, enabled) => ({
  action: 'set',
  id,
  enabled,
  incarnation: current.configuration.incarnation,
  revision: current.configuration.revision,
});
const setBusy = (value) => {
  busy = value;
  $('#plugin-settings').setAttribute('aria-busy', String(value));
  document.querySelectorAll('#plugin-settings [data-manage]').forEach((node) => {
    node.disabled = value || !current?.canManage || current.configuration.state !== 'valid';
  });
  $('#plugin-confirm').disabled = value || !pending;
  $('#plugin-cancel').disabled = value;
  $('#plugin-reload').disabled = value;
  document.querySelectorAll('#plugin-config-actions button').forEach((node) => {
    node.disabled = value || !current?.canManage;
  });
};
const resetPreview = (message = '选择一项启停操作，先查看依赖与影响，再明确提交。') => {
  pending = null;
  $('#plugin-preview-content').replaceChildren(el('p', 'muted', message));
  $('#plugin-preview-actions').hidden = true;
};
const renderRuntime = (row, card) => {
  const runtime = row.runtime;
  const state = card.querySelector('[data-runtime]');
  state.textContent = phases[runtime.phase];
  state.className = `plugin-phase plugin-phase-${runtime.phase}`;
  const lines = [];
  lines.push(row.enabled ? '用户开关：开启' : '用户开关：关闭');
  lines.push(runtime.gateApplied ? '本宿主门控已复核' : '门控尚未完成复核');
  if (runtime.inFlight)
    lines.push(
      `${runtime.inFlight} 个相关工具/来源调用，其中 ${runtime.revokedInFlight} 个旧调用待收尾`,
    );
  if (runtime.task)
    lines.push(
      `自动任务：${phases[runtime.task.phase]} · 在途 ${runtime.task.inFlight}${runtime.task.drainTimedOut ? ' · 排空超时，尚未安全卸载' : ''}`,
    );
  for (const task of runtime.dependentTasks)
    if (task.inFlight || task.phase === 'draining')
      lines.push(
        `关联自动任务：${phases[task.phase]} · 在途 ${task.inFlight}${task.drainTimedOut ? ' · 排空超时' : ''}`,
      );
  card.querySelector('[data-runtime-detail]').textContent = lines.join('；');
  card.querySelector('[data-blockers]').textContent = row.blockers.length
    ? row.blockers.join('；')
    : '操作仍受账户、场景与资料门禁约束。';
};
const renderView = (view, rebuild) => {
  current = view;
  $('#plugin-summary').replaceChildren(
    el('div', '', [
      el('strong', '', String(view.plugins.filter((row) => row.enabled).length)),
      el('span', '', '项开关开启'),
    ]),
    el('div', '', [
      el(
        'strong',
        '',
        String(view.plugins.filter((row) => row.runtime.phase === 'draining').length),
      ),
      el('span', '', '项正在排空'),
    ]),
    el('div', '', [
      el(
        'strong',
        '',
        view.configuration.revision === null ? '—' : `v${view.configuration.revision}`,
      ),
      el('span', '', '本地配置版本'),
    ]),
  );
  if (rebuild) {
    const open = new Set(
      [...document.querySelectorAll('#plugin-groups details[open]')].map((node) => node.dataset.id),
    );
    const root = $('#plugin-groups');
    root.replaceChildren();
    for (const [kind, label] of Object.entries(groups)) {
      const section = el('section', 'plugin-group');
      section.append(el('h3', '', label));
      for (const row of view.plugins.filter((row) => row.kind === kind)) {
        const card = el('article', 'plugin-card card');
        card.dataset.plugin = row.id;
        const state = el('span');
        state.dataset.runtime = '';
        const action = el(
          'button',
          `btn ${row.enabled ? 'btn-outline' : 'btn-primary'} btn-sm`,
          row.enabled ? '预览停用' : '预览启用',
        );
        action.type = 'button';
        action.dataset.manage = '';
        action.setAttribute('aria-label', `${row.enabled ? '预览停用' : '预览启用'}${row.label}`);
        action.addEventListener('click', () => {
          void preview(command(row.id, !row.enabled));
        });
        card.append(el('div', 'plugin-card-heading', [el('h4', '', row.label), state, action]));
        const detail = el('p', 'plugin-runtime-detail');
        detail.dataset.runtimeDetail = '';
        const blockers = el('p', 'plugin-blockers');
        blockers.dataset.blockers = '';
        card.append(
          detail,
          el(
            'p',
            'plugin-dependencies',
            row.requires.length
              ? `前置插件：${row.requires.map((item) => `${item.label}（${item.enabled ? '已开' : '已关'}）`).join('、')}`
              : '无前置插件；模型、供数与宿主权限仍需就绪。',
          ),
          blockers,
        );
        const details = el('details', 'plugin-details');
        details.dataset.id = row.id;
        details.open = open.has(row.id);
        details.append(
          el('summary', '', `相关操作 ${row.contributions.length} 项 · 查看贡献与标识`),
          el('code', '', `${row.id} · epoch ${row.epoch ?? '未配置'}`),
        );
        const list = el('ul');
        for (const item of row.contributions)
          list.append(
            el('li', '', [
              el('code', '', item.name),
              ` · ${item.effect === 'owned' ? '直接受控' : item.effect === 'optional' ? '可选解释降级' : '来源路由可能变化'}`,
            ]),
          );
        if (!row.contributions.length)
          list.append(
            el(
              'li',
              '',
              row.id === 'task.strategy-schedules'
                ? '自动策略调度；依赖策略执行，报告截止与补投独立。'
                : row.id === 'task.minute-bars-sync'
                  ? '分钟行情采集；停用保留本地历史查询。'
                  : '当前宿主暂无此插件的已登记操作。',
            ),
          );
        details.append(list);
        card.append(details);
        section.append(card);
      }
      root.append(section);
    }
    const actions = $('#plugin-config-actions');
    actions.replaceChildren();
    if (view.configuration.state === 'missing' || view.configuration.missing.length) {
      const initialize = view.configuration.state === 'missing';
      const button = el(
        'button',
        'btn btn-outline',
        initialize ? '预览初始化' : '预览补齐新增插件',
      );
      button.type = 'button';
      button.addEventListener('click', () => {
        void preview(
          initialize
            ? { action: 'initialize', expected: 'absent' }
            : {
                action: 'migrate',
                incarnation: view.configuration.incarnation,
                revision: view.configuration.revision,
              },
        );
      });
      actions.append(
        el(
          'p',
          'muted',
          initialize
            ? '普通读取不会创建配置。初始化后只有策略 AI 保留原基线选择，其余插件关闭；启用不授予外部权限。'
            : '当前配置缺少新增项，补齐时保持旧开关，新项默认关闭。',
        ),
        button,
      );
    }
  }
  for (const row of view.plugins) {
    const card = [...document.querySelectorAll('[data-plugin]')].find(
      (node) => node.dataset.plugin === row.id,
    );
    if (card) renderRuntime(row, card);
  }
  setBusy(busy);
};

export const renderPluginSettings = async () => {
  if (busy || loading) return;
  loading = true;
  const epoch = generation;
  try {
    const result = await callApi('/api/settings/plugins');
    if (epoch !== generation) return;
    if (!result.ok) {
      status('插件状态读取失败，请重新加载', true);
      return;
    }
    const changed = current === null || version(current) !== version(result.data);
    if (changed && pending) {
      generation++;
      resetPreview('配置已变化，请重新预览后提交。');
    }
    renderView(result.data, changed);
    status(
      result.data.configuration.state === 'invalid'
        ? '插件配置不可用：请先在本地核对修复。已保存的事实仍可查询。'
        : result.data.configuration.state === 'missing'
          ? '尚未初始化。可预览基线，确认后显式创建配置。'
          : !result.data.canManage
            ? '只读模式：管理插件需开启 write。启用不会授予 external。'
            : '本地配置与当前 Web 状态已更新；其它宿主在下一安全点复核。',
      result.data.configuration.state === 'invalid',
    );
  } finally {
    loading = false;
  }
};

const preview = async (body) => {
  if (busy) return;
  generation++;
  setBusy(true);
  const result = await callApi('/api/settings/plugins/preview', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setBusy(false);
  if (!result.ok) {
    resetPreview('预览未完成，请重新加载后重试。');
    status(result.error?.message ?? result.error?.required ?? '预览失败', true);
    return;
  }
  pending = result.data;
  const content = $('#plugin-preview-content');
  content.replaceChildren();
  content.append(
    el(
      'p',
      'plugin-preview-intent',
      body.action === 'set'
        ? `${body.enabled ? '启用' : '停用'}：${current.plugins.find((row) => row.id === body.id).label}`
        : body.action === 'initialize'
          ? '初始化插件配置'
          : '补齐新增插件',
    ),
  );
  for (const row of pending.affected) {
    content.append(
      el('h4', '', row.label),
      el(
        'p',
        '',
        `${row.enabled ? '目标开启' : '目标关闭'} · ${row.contributions.filter((item) => item.effect === 'owned').length} 项直接操作`,
      ),
    );
    if (row.blockers.length)
      content.append(el('p', 'plugin-blockers', `开启后仍受阻断：${row.blockers.join('；')}`));
    const list = el('ul');
    for (const item of row.contributions)
      list.append(
        el('li', '', [
          el('code', '', item.name),
          ` · ${item.effect === 'owned' ? '随开关受控' : item.effect === 'optional' ? '可选 AI 解释变化，事实保留' : '可能改用其它已授权来源'}`,
        ]),
      );
    content.append(list);
  }
  const notes = el('ul', 'plugin-preview-notes');
  for (const note of pending.notes) notes.append(el('li', '', note));
  content.append(notes);
  $('#plugin-preview-actions').hidden = false;
  $('#plugin-confirm').textContent =
    body.action === 'set'
      ? `确认${body.enabled ? '启用' : '停用'}`
      : body.action === 'initialize'
        ? '确认初始化'
        : '确认补齐';
  setBusy(false);
  status('尚未保存。请核对依赖、影响与保留项。');
  $('#plugin-preview-title').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};
const save = async () => {
  if (!pending || busy) return;
  generation++;
  setBusy(true);
  const result = await callApi('/api/settings/plugins', {
    method: 'POST',
    body: JSON.stringify(pending.command),
  });
  setBusy(false);
  if (!result.ok) {
    resetPreview('提交未完成，须重新加载并预览。');
    status(result.error?.message ?? result.error?.required ?? '提交失败', true);
    return;
  }
  const message =
    result.data.applicationError ?? '配置已提交，当前宿主已复核门控；仍在排空的调用会继续显示。';
  renderView(result.data.view, true);
  resetPreview(message);
  status(message, Boolean(result.data.applicationError));
  reportStatus('插件配置已提交');
};
export const initPluginSettings = (setStatus) => {
  reportStatus = setStatus;
  if (initialized) return;
  initialized = true;
  $('#plugin-reload').addEventListener('click', () => {
    generation++;
    resetPreview();
    void renderPluginSettings();
  });
  $('#plugin-confirm').addEventListener('click', () => {
    void save();
  });
  $('#plugin-cancel').addEventListener('click', () => {
    generation++;
    resetPreview();
  });
  setInterval(() => {
    if (
      document.visibilityState !== 'hidden' &&
      window.location.hash.startsWith('#settings') &&
      new URLSearchParams(window.location.hash.split('?')[1]).get('tab') === 'plugins'
    )
      void renderPluginSettings();
  }, 1500);
};
