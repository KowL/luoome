import { callApi } from './api.js';
import { $, el, mount, resultErrorText } from './ui.js';

export const PLUGIN_STATUS_LABELS = {
  enabled: '已启用',
  disabled: '已关闭',
  missing: '缺失（未写入）',
  dependency_not_ready: '依赖未满足',
};

export const pluginStatusLabel = (status) => PLUGIN_STATUS_LABELS[status] ?? status;

const fileStateText = (check) => {
  if (check.file === 'missing') return '未找到 plugins.json：所有插件按关闭处理。';
  if (check.file === 'invalid') return 'plugins.json 无法解析：所有插件按关闭处理。';
  return 'plugins.json 已读取；缺省未写入的条目按关闭处理。';
};

const dependencyText = (dependencies) =>
  dependencies.length === 0
    ? '无'
    : dependencies
        .map(
          (dependency) =>
            `${dependency.id}：${dependency.enabled ? '已启用' : '未启用'}${dependency.ready ? '' : '（依赖链未满足）'}`,
        )
        .join('；');

const tableOf = (check) =>
  el('div', 'table-wrap', [
    el('table', 'table', [
      el(
        'thead',
        null,
        el(
          'tr',
          null,
          ['ID', '类型', '配置', '启用', '依赖', '状态'].map((label) => el('th', null, label)),
        ),
      ),
      el(
        'tbody',
        null,
        check.plugins.map((plugin) =>
          el('tr', null, [
            el('td', null, [
              el('div', 'mono', plugin.id),
              el('div', 'cell-sub muted', plugin.label),
            ]),
            el('td', null, plugin.kind),
            el('td', null, plugin.configured ? '已写入' : '缺失'),
            el('td', null, plugin.enabled ? '是' : '否'),
            el('td', 'muted', dependencyText(plugin.dependencies)),
            el(
              'td',
              plugin.status === 'enabled' ? 'pos' : 'muted',
              pluginStatusLabel(plugin.status),
            ),
          ]),
        ),
      ),
    ]),
  ]);

const unknownSection = (check) =>
  check.unknown.length === 0
    ? []
    : [
        el('section', 'mt-3', [
          el('h3', null, '未知 id'),
          el('p', 'muted', '这些 key 不属于当前插件清单：会被忽略，请核对拼写或删除。'),
          ...check.unknown.map((entry) =>
            el('p', null, [
              el('code', null, entry.id),
              entry.suggestions.length === 0
                ? ''
                : ` → 是否想写 ${entry.suggestions.join(' / ')}？`,
            ]),
          ),
        ]),
      ];

export const renderPluginSettings = async (setStatus = () => {}) => {
  const body = $('#plugin-settings-body');
  if (body === null) return;
  const result = await callApi('/api/settings/plugins');
  if (!result.ok) {
    mount(body, el('p', 'status error', `插件状态读取失败：${resultErrorText(result)}`));
    return;
  }
  const check = result.data;
  const pathNode = $('#plugin-config-path');
  if (pathNode !== null) pathNode.textContent = check.path;
  const { summary } = check;
  mount(body, [
    el('p', check.file === 'ok' ? 'muted' : 'status warning', fileStateText(check)),
    el(
      'p',
      'muted',
      `共 ${summary.total} 个插件：已启用 ${summary.enabled} · 已关闭 ${summary.disabled} · 缺失 ${summary.missing} · 依赖未满足 ${summary.dependencyNotReady} · 未知 id ${summary.unknown}`,
    ),
    tableOf(check),
    ...unknownSection(check),
    el(
      'p',
      'muted',
      '本页只读：不会修改 plugins.json。手写文件后重启 Web / CLI 进程才会重新装配插件；启用不授予 write / external。',
    ),
  ]);
  setStatus('插件启用状态已更新');
};
