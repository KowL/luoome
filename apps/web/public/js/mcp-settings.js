import { callApi } from './api.js';
import { $, el } from './ui.js';

const SCENARIOS = {
  research: '股票研究',
  portfolio: '账户持仓',
  watch: '观察盯盘',
  review: '复盘',
  general: '通用对话',
};
let initialized = false;
let current = null;
let reportStatus = () => {};
let busy = false;

const status = (message, error = false) => {
  const node = $('#mcp-settings-status');
  node.textContent = message;
  node.classList.toggle('error', error);
};
const resetPreview = () => {
  $('#mcp-preview-result').textContent = '配置已更新，请重新预览';
};
const setBusy = (value) => {
  busy = value;
  document
    .querySelectorAll(
      '#mcp-settings button, #mcp-settings input, #mcp-settings textarea, #mcp-settings select',
    )
    .forEach((node) => {
      node.disabled = value || !current?.canManage || Boolean(current?.configError);
    });
  $('#mcp-reload').disabled = value;
};

const renderServices = () => {
  const list = $('#mcp-service-list');
  list.replaceChildren();
  for (const service of current.services) {
    const form = el('form', 'mcp-service card');
    form.dataset.service = service.id;
    const heading = el('div', 'mcp-service-heading');
    heading.append(el('div', '', [el('h3', '', service.label), el('code', 'muted', service.id)]));
    heading.append(
      el(
        'span',
        `mcp-service-state${service.enabled ? ' enabled' : ''}`,
        service.enabled ? '已启用' : '已停用',
      ),
    );
    form.append(heading);
    const enabled = el('input');
    enabled.type = 'checkbox';
    enabled.name = 'enabled';
    enabled.checked = service.enabled;
    form.append(el('label', 'mcp-enabled', [enabled, '向 Agent 开放此服务']));
    const tools = el('textarea');
    tools.name = 'tools';
    tools.rows = 3;
    tools.value = service.tools.join('\n');
    tools.id = `mcp-tools-${service.id}`;
    tools.spellcheck = false;
    tools.maxLength = 800;
    const toolsLabel = el('label', 'mcp-field', ['工具白名单', tools]);
    toolsLabel.htmlFor = tools.id;
    form.append(
      toolsLabel,
      el('p', 'mcp-note', '填写远端工具原名，每行一个；留空表示不授权任何工具。'),
    );
    const scenes = el('fieldset', 'mcp-scenes');
    scenes.append(el('legend', '', '适用场景'));
    for (const [id, label] of Object.entries(SCENARIOS)) {
      const input = el('input');
      input.type = 'checkbox';
      input.name = 'scenarios';
      input.value = id;
      input.checked = service.scenarios.includes(id);
      scenes.append(el('label', '', [input, label]));
    }
    form.append(scenes);
    const save = el('button', 'btn btn-primary', '保存服务');
    save.type = 'submit';
    form.append(
      el('div', 'mcp-service-footer', [el('span', 'mcp-note', '停用会撤销工具授权'), save]),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void saveService(service.id, form);
    });
    list.append(form);
  }
  if (!current.services.length)
    list.append(el('p', 'muted', current.configError ?? '暂无已登记的 MCP 服务。'));
  setBusy(false);
};

export const renderMcpSettings = async (setStatus = reportStatus) => {
  reportStatus = setStatus;
  if (busy) return;
  status('正在读取配置');
  const result = await callApi('/api/settings/mcp');
  if (!result.ok) {
    status('MCP 设置读取失败，请重新加载', true);
    return;
  }
  current = result.data;
  renderServices();
  status(
    current.configError ??
      (!current.canManage
        ? '当前为只读模式：管理服务需同时开启 write 与 external。'
        : '仅管理已登记的受信服务；新增服务的启动配置请在本地登记。'),
    Boolean(current.configError),
  );
};

const saveService = async (id, form) => {
  if (busy) return;
  const scenarios = [...form.querySelectorAll('input[name="scenarios"]:checked')].map(
    (input) => input.value,
  );
  if (!scenarios.length) {
    status('请至少选择一个适用场景', true);
    return;
  }
  const tools = form.elements.tools.value.split(/\s+/).filter(Boolean);
  if (
    tools.length > 16 ||
    new Set(tools).size !== tools.length ||
    tools.some((name) => !/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(name))
  ) {
    status('工具原名需唯一、最多 16 个，仅支持字母、数字、下划线和短横线', true);
    return;
  }
  const body = {
    enabled: form.elements.enabled.checked,
    tools,
    scenarios,
    revision: current.revision,
  };
  setBusy(true);
  const result = await callApi(`/api/settings/mcp/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setBusy(false);
  if (!result.ok) {
    status(result.error?.message ?? result.error?.required ?? '保存失败，请重新加载后重试', true);
    return;
  }
  current = result.data;
  renderServices();
  resetPreview();
  status('已保存，下轮对话立即使用新授权。');
  reportStatus('MCP 服务设置已保存');
};

const preview = async () => {
  if (busy) return;
  setBusy(true);
  const result = await callApi('/api/settings/mcp/preview', {
    method: 'POST',
    body: JSON.stringify({ scenario: $('#mcp-preview-scenario').value }),
  });
  setBusy(false);
  const output = $('#mcp-preview-result');
  output.replaceChildren();
  if (!result.ok) {
    output.textContent = result.error?.message ?? result.error?.required ?? '预览失败';
    return;
  }
  if (!result.data.tools.length) {
    output.textContent = '所选场景暂无可用的 MCP 工具';
    return;
  }
  output.append(el('p', '', `${result.data.tools.length} 个可用工具`));
  for (const tool of result.data.tools) output.append(el('code', 'mcp-tool-name', tool.name));
};

export const initMcpSettings = (setStatus) => {
  reportStatus = setStatus;
  if (initialized) return;
  initialized = true;
  $('#mcp-reload')?.addEventListener('click', () => {
    resetPreview();
    void renderMcpSettings();
  });
  $('#mcp-preview-button')?.addEventListener('click', () => void preview());
  $('#mcp-preview-scenario')?.addEventListener('change', resetPreview);
};
