/* LLM 设置：provider presets、凭证状态与即时应用。 */

import { callApi } from './api.js';
import { $ } from './ui.js';

let providers = [];
let initialized = false;

const selectedProvider = () => {
  const id = $('#ai-provider')?.value ?? '';
  return providers.find((provider) => provider.id === id) ?? null;
};

const setPanelState = (message, kind = '') => {
  const state = $('#ai-settings-state');
  if (state === null) return;
  state.className = `ai-settings-state${kind === '' ? '' : ` ${kind}`}`;
  state.querySelector('span:last-child').textContent = message;
};

const applyReasoningCapability = () => {
  const preset = selectedProvider();
  const select = $('#ai-reasoning-effort');
  const hint = $('#ai-reasoning-hint');
  if (select === null || hint === null || preset === null) return;
  const supported = Array.isArray(preset.supportedReasoningEfforts)
    ? preset.supportedReasoningEfforts
    : ['off'];
  for (const option of select.options) option.disabled = !supported.includes(option.value);
  if (!supported.includes(select.value)) select.value = supported[0] ?? 'off';
  select.disabled = !preset.supportsReasoningEffort;
  if (!preset.supportsReasoningEffort) {
    select.value = 'off';
    hint.textContent = `${preset.label} 不使用统一 reasoningEffort 参数。`;
  } else {
    hint.textContent = `${preset.label} 支持：${supported.join(' / ')}。`;
  }
};

const applyTemperatureCapability = () => {
  const preset = selectedProvider();
  const input = $('#ai-temperature');
  const hint = $('#ai-temperature-hint');
  if (input === null || hint === null || preset === null) return;
  const fixed = Number(preset.fixedTemperature);
  if (Number.isFinite(fixed)) {
    input.value = String(fixed);
    input.disabled = true;
    hint.textContent = `${preset.label} 要求固定为 ${fixed}。`;
  } else {
    input.disabled = false;
    hint.textContent = '越低越稳定，越高越发散。';
  }
};

const applyProviderDefaults = () => {
  const preset = selectedProvider();
  if (preset === null) return;
  $('#ai-model').value = preset.defaultModel;
  $('#ai-base-url').value = preset.defaultBaseURL;
  $('#ai-temperature').value = String(preset.defaultTemperature);
  applyReasoningCapability();
  applyTemperatureCapability();
};

const mountProviderOptions = (selected) => {
  const select = $('#ai-provider');
  if (select === null) return;
  select.replaceChildren(
    ...providers.map((provider) => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.label;
      option.selected = provider.id === selected;
      return option;
    }),
  );
};

const renderAISettings = async (setStatus) => {
  setPanelState('正在读取配置');
  const result = await callApi('/api/settings/ai');
  if (!result.ok) {
    setPanelState('配置不可用', 'error');
    setStatus(
      `LLM 设置加载失败：${result.error?.message ?? result.error?.kind ?? 'unknown'}`,
      true,
    );
    return;
  }
  const data = result.data;
  providers = Array.isArray(data.providers) ? data.providers : [];
  mountProviderOptions(data.provider);
  $('#ai-model').value = data.model;
  $('#ai-base-url').value = data.baseURL;
  $('#ai-api-key').value = '';
  $('#ai-clear-key').checked = false;
  $('#ai-temperature').value = String(data.temperature);
  $('#ai-timeout').value = String(data.timeoutSeconds);
  $('#ai-max-retries').value = String(data.maxRetries);
  $('#ai-reasoning-effort').value = data.reasoningEffort;
  $('#ai-key-status').textContent = data.apiKeyConfigured
    ? '已配置 · 保存时留空可继续使用'
    : '尚未配置';
  $('#ai-config-path').textContent = data.configPath;
  $('#ai-config-path').title = data.configPath;
  $('#ai-secret-path').textContent = data.secretPath;
  $('#ai-secret-path').title = data.secretPath;
  applyReasoningCapability();
  applyTemperatureCapability();
  if (data.configError) {
    setPanelState('配置需要修复', 'error');
    setStatus('现有 AI 配置无法解析；页面已载入推荐值，保存即可覆盖修复。', true);
  } else {
    setPanelState(
      data.apiKeyConfigured ? '模型已配置' : '等待 API Key',
      data.apiKeyConfigured ? 'ready' : '',
    );
  }
};

const saveAISettings = async (setStatus) => {
  const form = $('#ai-settings-form');
  if (form === null || !form.reportValidity()) return;
  const button = $('#btn-ai-save');
  const input = {
    provider: $('#ai-provider').value,
    model: $('#ai-model').value.trim(),
    baseURL: $('#ai-base-url').value.trim(),
    apiKey: $('#ai-api-key').value.trim() || undefined,
    clearApiKey: $('#ai-clear-key').checked,
    temperature: Number($('#ai-temperature').value),
    timeoutSeconds: Number($('#ai-timeout').value),
    maxRetries: Number($('#ai-max-retries').value),
    reasoningEffort: $('#ai-reasoning-effort').value,
  };
  button.disabled = true;
  setPanelState('正在校验并应用');
  const result = await callApi('/api/settings/ai', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  button.disabled = false;
  if (!result.ok) {
    setPanelState('保存失败', 'error');
    const detail =
      result.error?.message ?? result.error?.required ?? result.error?.kind ?? 'unknown';
    setStatus(`LLM 设置保存失败：${detail}`, true);
    return;
  }
  button.classList.add('saved');
  button.textContent = '✓ 已保存并生效';
  window.setTimeout(() => {
    button.classList.remove('saved');
    button.innerHTML = '<span aria-hidden="true">▣</span> 保存并应用';
  }, 1_500);
  setStatus('LLM 设置已安全保存，并应用到当前 Web 进程');
  await renderAISettings(setStatus);
};

const initAISettings = (setStatus) => {
  if (initialized) return;
  initialized = true;
  $('#ai-provider')?.addEventListener('change', applyProviderDefaults);
  $('#btn-ai-provider-defaults')?.addEventListener('click', applyProviderDefaults);
  $('#ai-api-key')?.addEventListener('input', () => {
    if ($('#ai-api-key').value.length > 0) $('#ai-clear-key').checked = false;
  });
  $('#ai-clear-key')?.addEventListener('change', () => {
    if ($('#ai-clear-key').checked) $('#ai-api-key').value = '';
  });
  $('#ai-settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveAISettings(setStatus);
  });
};

export { applyProviderDefaults, initAISettings, renderAISettings, saveAISettings };
