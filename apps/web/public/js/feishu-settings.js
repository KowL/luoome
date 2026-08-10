/* 飞书通知设置：Webhook 密钥不回显，保存与外部连接测试分离授权。 */

import { callApi } from './api.js';
import { $ } from './ui.js';

let initialized = false;
let configured = false;

const setPanelState = (message, kind = '') => {
  const state = $('#feishu-settings-state');
  if (state === null) return;
  state.className = `ai-settings-state${kind === '' ? '' : ` ${kind}`}`;
  state.querySelector('span:last-child').textContent = message;
};

const settingsPayload = () => ({
  webhookUrl: $('#feishu-webhook-url')?.value.trim() || undefined,
  clearWebhook: $('#feishu-clear-webhook')?.checked ?? false,
});

const renderFeishuSettings = async (setStatus) => {
  setPanelState('正在读取配置');
  const result = await callApi('/api/settings/feishu');
  if (!result.ok) {
    setPanelState('配置不可用', 'error');
    setStatus(
      `飞书设置加载失败：${result.error?.message ?? result.error?.kind ?? 'unknown'}`,
      true,
    );
    return;
  }
  configured = result.data.configured === true;
  $('#feishu-webhook-url').value = '';
  $('#feishu-clear-webhook').checked = false;
  $('#feishu-webhook-status').textContent = configured ? '已配置 · 留空保存可继续使用' : '尚未配置';
  $('#feishu-delivery-label').textContent = configured ? '通道已就绪' : '等待配置';
  $('#btn-feishu-test').disabled = !configured;
  setPanelState(configured ? 'Webhook 已配置' : '等待 Webhook', configured ? 'ready' : '');
};

const saveFeishuSettings = async (setStatus) => {
  const form = $('#feishu-settings-form');
  if (form === null || !form.reportValidity()) return;
  const input = settingsPayload();
  if (!configured && input.webhookUrl === undefined && !input.clearWebhook) {
    setStatus('请填写飞书自定义机器人 Webhook', true);
    $('#feishu-webhook-url').focus();
    return;
  }
  const button = $('#btn-feishu-save');
  button.disabled = true;
  setPanelState('正在安全保存');
  const result = await callApi('/api/settings/feishu', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  button.disabled = false;
  if (!result.ok) {
    setPanelState('保存失败', 'error');
    setStatus(
      `飞书设置保存失败：${result.error?.message ?? result.error?.required ?? result.error?.kind ?? 'unknown'}`,
      true,
    );
    return;
  }
  button.classList.add('saved');
  button.textContent = '✓ 已保存并生效';
  window.setTimeout(() => {
    button.classList.remove('saved');
    button.textContent = '保存并应用';
  }, 1_500);
  setStatus(result.data.configured ? '飞书 Webhook 已安全保存并生效' : '飞书 Webhook 已清除');
  await renderFeishuSettings(setStatus);
};

const testFeishuSettings = async (setStatus) => {
  const button = $('#btn-feishu-test');
  button.disabled = true;
  setPanelState('正在发送测试消息');
  const result = await callApi('/api/settings/feishu/test', { method: 'POST' });
  button.disabled = false;
  if (!result.ok) {
    setPanelState('测试失败', 'error');
    setStatus(
      `飞书连接测试失败：${result.error?.message ?? result.error?.cause ?? result.error?.required ?? result.error?.kind ?? 'unknown'}`,
      true,
    );
    return;
  }
  setPanelState('测试消息已送达', 'ready');
  setStatus('飞书测试消息发送成功，请在目标群确认');
};

const initFeishuSettings = (setStatus) => {
  if (initialized) return;
  initialized = true;
  $('#feishu-webhook-url')?.addEventListener('input', () => {
    if ($('#feishu-webhook-url').value.length > 0) $('#feishu-clear-webhook').checked = false;
  });
  $('#feishu-clear-webhook')?.addEventListener('change', () => {
    if ($('#feishu-clear-webhook').checked) $('#feishu-webhook-url').value = '';
  });
  $('#feishu-settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveFeishuSettings(setStatus);
  });
  $('#btn-feishu-test')?.addEventListener('click', () => void testFeishuSettings(setStatus));
};

export {
  initFeishuSettings,
  renderFeishuSettings,
  saveFeishuSettings,
  settingsPayload,
  testFeishuSettings,
};
