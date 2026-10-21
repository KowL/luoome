import { callApi, getHostedSession, getSessionEpoch } from './api.js';

let lifecycle;
export const renderHostedAISettings = async (box) => {
  lifecycle?.abort();
  lifecycle = new AbortController();
  const epoch = getSessionEpoch();
  const userId = getHostedSession()?.user.id;
  const current = () =>
    box.isConnected &&
    getSessionEpoch() === epoch &&
    getHostedSession()?.user.id === userId &&
    getHostedSession()?.admin;
  box.className = 'hosted-ai-settings';
  box.innerHTML = '<h3>AI 服务配置</h3><p class="muted" role="status">正在读取配置…</p>';
  const result = await callApi('/api/admin/ai-settings');
  if (!current()) return;
  if (!result.ok) {
    box.querySelector('p').textContent = '无法读取 AI 配置，请稍后重试。';
    return;
  }
  let view = result.data;
  box.innerHTML = `
    <div class="hosted-ai-heading"><div><h3>AI 服务配置</h3><p class="muted">管理员设置 · 对所有用户生效</p></div><span class="hosted-ai-state"></span></div>
    <form autocomplete="off">
      <fieldset>
        <label class="hosted-check"><input name="enabled" type="checkbox">启用 AI 对话与方向研究</label>
        <div class="hosted-ai-grid">
          <label class="field">供应商<select name="provider"><option value="deepseek">DeepSeek</option><option value="kimi">Kimi</option><option value="openai-compatible">其他 OpenAI 兼容服务</option></select></label>
          <label class="field">模型名称<input name="model" required maxlength="200" placeholder="供应商提供的模型 ID"></label>
          <label class="field hosted-ai-wide">API 地址（OpenAI 兼容）<input name="baseURL" type="url" required placeholder="https://…/v1" spellcheck="false"><small class="muted">请填写 OpenAI 兼容基础地址，不要填写 Anthropic 接口。MiniMax 示例：https://api.minimax.cn/v1</small></label>
          <label class="field hosted-ai-wide">API 密钥<input name="apiKey" type="password" autocomplete="new-password" maxlength="1000" spellcheck="false"><small class="muted" data-key-status></small></label>
        </div>
        <label class="hosted-check"><input name="clearApiKey" type="checkbox">清除已保存的密钥</label>
        <details><summary>模型参数与费用预算</summary>
          <p class="muted">费率单位：人民币 / 百万 Token。请按供应商费率填写，费用为据此计算的记录；订阅会员配额不能直接换算成此费率。</p>
          <div class="hosted-ai-grid">
            <label class="field">输入费率<input name="inputPrice" type="number" min="0" max="100000" step="0.000001" required></label>
            <label class="field">缓存输入费率<input name="cachedInputPrice" type="number" min="0" max="100000" step="0.000001" required></label>
            <label class="field">输出费率<input name="outputPrice" type="number" min="0" max="100000" step="0.000001" required></label>
            <label class="field">单次预算（元）<input name="callBudget" type="number" min="0.000001" max="1000" step="0.000001" required></label>
            <label class="field">每用户订阅周期预算（元）<input name="periodBudget" type="number" min="0.000001" max="10000" step="0.000001" required></label>
            <label class="field">温度<input name="temperature" type="number" min="0" max="2" step="0.1" required></label>
            <label class="field">推理强度<select name="reasoningEffort"><option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="max">最高</option></select></label>
            <label class="field">请求超时（秒）<input name="timeoutSeconds" type="number" min="10" max="300" step="1" required></label>
            <label class="field">最大输出 Token<input name="maxOutputTokens" type="number" min="256" max="32768" step="1" required></label>
          </div>
          <p class="muted">服务需支持 Chat Completions 和用量回执；缺少必需用量时会停止并标记待核对。推理参数请以所选模型为准。</p>
        </details>
        <div class="hosted-actions"><button class="btn btn-primary" type="submit">保存配置</button></div>
      </fieldset>
      <p class="muted" role="status" aria-live="polite" data-save-status>密钥不会回显。保存后，后续请求使用新配置；保存不会自动调用模型。</p>
    </form>`;
  const form = box.querySelector('form');
  const fields = form.elements;
  const status = box.querySelector('[data-save-status]');
  const numeric = new Set([
    'temperature',
    'timeoutSeconds',
    'maxOutputTokens',
    'inputPrice',
    'cachedInputPrice',
    'outputPrice',
    'callBudget',
    'periodBudget',
  ]);
  const populate = () => {
    for (const [name, value] of Object.entries(view.settings)) {
      if (name === 'enabled') fields.namedItem(name).checked = value;
      else fields.namedItem(name).value = value;
    }
    fields.namedItem('apiKey').value = '';
    fields.namedItem('apiKey').placeholder = view.apiKeyConfigured
      ? '已配置；供应商和地址不变时可留空'
      : '请输入 API 密钥';
    fields.namedItem('clearApiKey').checked = false;
    box.querySelector('[data-key-status]').textContent = view.apiKeyConfigured
      ? '密钥已保存。更换供应商或地址时需重新填写。'
      : '尚未配置密钥。';
    box.querySelector('.hosted-ai-state').textContent = view.settings.enabled
      ? '已启用 · 未验证连接'
      : '未启用';
  };
  populate();
  document.addEventListener(
    'luoome:identity-cleared',
    () => {
      fields.namedItem('apiKey').value = '';
      box.replaceChildren();
    },
    { once: true, signal: lifecycle.signal },
  );
  fields.namedItem('provider').addEventListener('change', () => {
    fields.namedItem('apiKey').value = '';
    fields.namedItem('model').value = '';
    fields.namedItem('baseURL').value = {
      deepseek: 'https://api.deepseek.com',
      kimi: 'https://api.moonshot.cn/v1',
      'openai-compatible': '',
    }[fields.namedItem('provider').value];
    for (const name of ['inputPrice', 'cachedInputPrice', 'outputPrice'])
      fields.namedItem(name).value = '';
    form.querySelector('details').open = true;
    status.textContent = '请填写模型、密钥和对应费率后保存。';
  });
  let saving = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || !current()) return;
    form.querySelector('details').open = true;
    if (!form.reportValidity()) return;
    const settings = Object.fromEntries(
      Object.keys(view.settings).map((name) => [
        name,
        name === 'enabled'
          ? fields.namedItem(name).checked
          : numeric.has(name)
            ? Number(fields.namedItem(name).value)
            : fields.namedItem(name).value.trim(),
      ]),
    );
    const input = {
      settings,
      apiKey: fields.namedItem('apiKey').value,
      clearApiKey: fields.namedItem('clearApiKey').checked,
    };
    fields.namedItem('apiKey').value = '';
    saving = true;
    form.querySelector('fieldset').disabled = true;
    status.textContent = '正在保存…';
    try {
      const saved = await callApi('/api/admin/ai-settings', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!current()) return;
      if (!saved.ok) {
        status.textContent = `${saved.error?.message ?? '保存失败，请稍后重试。'}${input.apiKey ? '；本次填写的密钥已清空，请重新填写后重试。' : ''}`;
        return;
      }
      view = saved.data;
      populate();
      status.textContent = view.settings.enabled
        ? '配置已保存，后续 AI 请求将使用新配置。'
        : '配置已保存，AI 已停用。';
    } catch {
      if (current()) status.textContent = '保存失败，请稍后重试；新密钥需要重新填写。';
    } finally {
      input.apiKey = '';
      saving = false;
      if (current()) form.querySelector('fieldset').disabled = false;
    }
  });
};
