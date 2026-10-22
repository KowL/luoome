import { callApi, getHostedSession, getSessionEpoch } from './api.js';

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const button = (text, action, className = 'btn btn-ghost') => {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
};
const modelFields = [
  ['id', '模型 ID', 'text'],
  ['name', '显示名称', 'text'],
  ['maxOutputTokens', '最大输出 Token', 'number', 256, 32768, 1],
  ['temperature', '温度', 'number', 0, 2, 0.1],
  ['timeoutSeconds', '请求超时（秒）', 'number', 10, 300, 1],
  ['inputPrice', '输入费率', 'number', 0, 100000, 0.000001],
  ['cachedInputPrice', '缓存输入费率', 'number', 0, 100000, 0.000001],
  ['outputPrice', '输出费率', 'number', 0, 100000, 0.000001],
];
const newModel = (id = '', name = id) => ({
  id,
  name,
  maxOutputTokens: 2048,
  temperature: 0.2,
  timeoutSeconds: 60,
  reasoningEffort: 'off',
  inputPrice: 0,
  cachedInputPrice: 0,
  outputPrice: 0,
});

let lifecycle;
export const renderHostedAISettings = async (box) => {
  lifecycle?.abort();
  const controller = new AbortController();
  lifecycle = controller;
  const epoch = getSessionEpoch();
  const userId = getHostedSession()?.user.id;
  const current = () =>
    !controller.signal.aborted &&
    box.isConnected &&
    getSessionEpoch() === epoch &&
    getHostedSession()?.user.id === userId &&
    getHostedSession()?.admin;
  box.className = 'hosted-ai-settings';
  box.innerHTML = '<h2>AI 模型</h2><p class="muted" role="status">正在读取配置…</p>';
  if (!getHostedSession()?.admin) {
    box.querySelector('p').textContent = '仅管理员可以配置全站 AI 模型。';
    return;
  }
  const loaded = await callApi('/api/admin/ai-settings');
  if (!current()) return;
  if (!loaded.ok) {
    box.querySelector('p').textContent = '无法读取模型配置，请重试。';
    box.append(button('重新加载', () => renderHostedAISettings(box)));
    return;
  }
  let view = loaded.data;
  let busy = false;
  let activeEditor;
  const status = element('p', '', 'muted ai-model-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  document.addEventListener(
    'luoome:identity-cleared',
    () => {
      box.querySelectorAll('input[name="apiKey"]').forEach((input) => {
        input.value = '';
      });
      controller.abort();
      box.replaceChildren();
    },
    { once: true, signal: controller.signal },
  );

  const apply = async (input, form) => {
    if (busy || !current()) return false;
    busy = true;
    form.querySelector('fieldset').disabled = true;
    status.textContent = '正在应用配置…';
    try {
      const result = await callApi('/api/admin/ai-settings/catalog', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!current()) return false;
      if (!result.ok) {
        status.textContent = `${result.error?.message ?? '保存失败，请稍后重试。'}${input.apiKey ? '；新密钥已清空，请重新填写。' : ''}`;
        return false;
      }
      view = result.data;
      activeEditor = undefined;
      render();
      status.textContent = '配置已应用。保存供应商不会改变当前选择的模型。';
      return true;
    } catch {
      if (current()) status.textContent = '保存失败，请稍后重试；如填写了新密钥，请重新填写。';
      return false;
    } finally {
      input.apiKey = '';
      busy = false;
      if (current() && form.isConnected) form.querySelector('fieldset').disabled = false;
    }
  };

  const editor = (provider, card, defaultsForm) => {
    if (activeEditor || busy) return;
    defaultsForm.querySelector('fieldset').disabled = true;
    box.querySelectorAll('.ai-provider-row button, .ai-provider-add > button').forEach((node) => {
      node.disabled = true;
    });
    const revision = view.revision;
    const creating = provider === undefined;
    const initial = provider ?? { id: '', name: '', baseURL: '', models: [] };
    const form = element('form', undefined, 'ai-provider-editor');
    form.autocomplete = 'off';
    form.noValidate = true;
    form.innerHTML = `<fieldset>
      <div data-create></div>
      <div class="hosted-ai-grid" data-identity>
        <label class="field">Provider ID<input name="providerId" required maxlength="64" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" placeholder="my-provider" spellcheck="false"></label>
        <label class="field">供应商名称<input name="providerName" required maxlength="100" placeholder="供应商或服务名称"></label>
      </div>
      <label class="field">API 密钥<div class="ai-key-input"><input name="apiKey" type="password" autocomplete="new-password" maxlength="1000" spellcheck="false"><button type="button" data-show-key aria-label="显示密钥">显示</button></div><small class="muted" data-key-help></small></label>
      <label class="hosted-check"><input name="clearApiKey" type="checkbox">清除已保存密钥</label>
      <details class="ai-provider-options" open><summary>自定义设置</summary>
        <div class="hosted-ai-grid">
          <label class="field">API 协议<select name="protocol"><option>OpenAI Chat Completions</option></select></label>
          <label class="field">API 基础地址<input name="baseURL" type="url" required placeholder="https://api.example.com/v1" spellcheck="false"><small class="muted">填写基础地址，系统会追加接口路径。</small></label>
        </div>
        <div class="ai-model-list-heading"><h4>模型选项</h4><div class="hosted-actions" data-model-actions></div></div>
        <p class="muted">费率单位为人民币 / 百万 Token。保存供应商时可暂不填写，启用模型前需要完善。</p>
        <div data-discovery></div><div data-model-list></div>
      </details>
      <div class="hosted-actions ai-editor-footer"><button class="btn btn-primary" type="submit">应用</button><button class="btn btn-ghost" type="button" data-cancel>取消</button></div>
    </fieldset>`;
    const fields = form.elements;
    fields.namedItem('providerId').value = initial.id;
    fields.namedItem('providerId').readOnly = !creating;
    fields.namedItem('providerName').value = initial.name;
    fields.namedItem('baseURL').value = initial.baseURL;
    fields.namedItem('apiKey').placeholder = provider?.apiKeyConfigured
      ? '已配置；留空保留当前密钥'
      : '请输入 API 密钥';
    form.querySelector('[data-key-help]').textContent =
      '已保存的密钥不会回显。更换 API 地址时需要重新填写密钥。';
    fields.namedItem('clearApiKey').closest('label').hidden = !provider?.apiKeyConfigured;
    const key = fields.namedItem('apiKey');
    const showKey = form.querySelector('[data-show-key]');
    const hideKey = () => {
      key.type = 'password';
      showKey.textContent = '显示';
      showKey.setAttribute('aria-label', '显示密钥');
    };
    key.addEventListener('input', hideKey);
    showKey.addEventListener('click', () => {
      if (!key.value) return;
      const show = key.type === 'password';
      key.type = show ? 'text' : 'password';
      showKey.textContent = show ? '隐藏' : '显示';
      showKey.setAttribute('aria-label', `${show ? '隐藏' : '显示'}密钥`);
    });
    const rows = form.querySelector('[data-model-list]');
    const addModel = (model, open = false) => {
      const row = element('details', undefined, 'ai-model-row');
      row.open = open;
      row.append(element('summary', model.name || model.id || '新模型'));
      const grid = element('div', undefined, 'hosted-ai-grid');
      for (const [name, label, type, min, max, step] of modelFields) {
        const field = element('label', label, 'field');
        const input = element('input');
        input.dataset.modelField = name;
        input.type = type;
        input.required = true;
        input.value = model[name];
        if (type === 'number') {
          input.min = min;
          input.max = max;
          input.step = step;
        } else input.maxLength = 200;
        if (name === 'id') input.spellcheck = false;
        if (name === 'name')
          input.addEventListener('input', () => {
            row.querySelector('summary').textContent = input.value || '新模型';
          });
        field.append(input);
        grid.append(field);
      }
      const reasoning = element('label', '推理强度', 'field');
      const select = element('select');
      select.dataset.modelField = 'reasoningEffort';
      for (const [value, label] of [
        ['off', '模型默认'],
        ['low', '低'],
        ['medium', '中'],
        ['high', '高'],
        ['max', '最高'],
      ]) {
        const option = element('option', label);
        option.value = value;
        select.append(option);
      }
      select.value = model.reasoningEffort;
      reasoning.append(select);
      grid.append(reasoning);
      row.append(grid);
      row.append(button('移除模型', () => row.remove(), 'btn btn-ghost btn-sm'));
      rows.append(row);
      return row;
    };
    for (const model of initial.models) addModel(model);
    const readModels = () =>
      [...rows.children].map((row) =>
        Object.fromEntries(
          [...row.querySelectorAll('[data-model-field]')].map((input) => [
            input.dataset.modelField,
            input.type === 'number' ? Number(input.value) : input.value.trim(),
          ]),
        ),
      );
    if (creating) {
      const create = form.querySelector('[data-create]');
      const label = element('label', '添加模型提供商', 'field');
      const select = element('select');
      select.setAttribute('aria-label', '选择模型提供商');
      select.append(element('option', '自定义模型 API'));
      select.firstChild.value = '';
      for (const preset of view.presets.filter(
        (item) => !view.providers.some((row) => row.id === item.id),
      )) {
        const option = element('option', preset.name);
        option.value = preset.id;
        select.append(option);
      }
      select.addEventListener('change', () => {
        const preset = view.presets.find((item) => item.id === select.value);
        fields.namedItem('providerId').value = preset?.id ?? '';
        fields.namedItem('providerName').value = preset?.name ?? '';
        fields.namedItem('baseURL').value = preset?.baseURL ?? '';
        key.value = '';
        hideKey();
        rows.replaceChildren();
        addModel(newModel(preset?.model), true);
      });
      label.append(select);
      create.append(label);
      addModel(newModel(), true);
    }
    const modelActions = form.querySelector('[data-model-actions]');
    modelActions.append(
      button(
        '手动添加',
        () => {
          const row = addModel(newModel(), true);
          row.querySelector('input').focus();
        },
        'btn btn-ghost btn-sm',
      ),
    );
    modelActions.append(
      button(
        '获取可用模型',
        async () => {
          if (busy || !current()) return;
          const baseURL = fields.namedItem('baseURL');
          if (!baseURL.reportValidity()) return;
          busy = true;
          form.querySelector('fieldset').disabled = true;
          const area = form.querySelector('[data-discovery]');
          area.replaceChildren(element('p', '正在获取模型列表…', 'muted'));
          const input = {
            providerId: fields.namedItem('providerId').value || undefined,
            baseURL: baseURL.value.trim(),
            apiKey: key.value,
          };
          try {
            const result = await callApi('/api/admin/ai-settings/models', {
              method: 'POST',
              body: JSON.stringify(input),
            });
            if (!current()) return;
            if (!result.ok) {
              area.replaceChildren(
                element('p', result.error?.message ?? '获取失败，可以继续手动添加。', 'muted'),
              );
              return;
            }
            const selected = new Set();
            const existing = new Set(readModels().map((model) => model.id));
            const candidates = result.data.models.filter((model) => !existing.has(model.id));
            if (!candidates.length) {
              area.replaceChildren(element('p', '没有可添加的新模型，可以继续手动填写。', 'muted'));
              return;
            }
            const search = element('input');
            search.type = 'search';
            search.placeholder = '搜索模型 ID 或名称';
            search.setAttribute('aria-label', '搜索可用模型');
            const list = element('div', undefined, 'ai-model-candidates');
            const paint = () => {
              const query = search.value.trim().toLowerCase();
              list.replaceChildren();
              for (const model of candidates.filter((item) =>
                `${item.id} ${item.name}`.toLowerCase().includes(query),
              )) {
                const label = element('label', undefined, 'hosted-check');
                const checkbox = element('input');
                checkbox.type = 'checkbox';
                checkbox.checked = selected.has(model.id);
                checkbox.addEventListener('change', () =>
                  checkbox.checked ? selected.add(model.id) : selected.delete(model.id),
                );
                const code = element('code', model.id);
                code.title = model.name;
                label.append(checkbox, code);
                list.append(label);
              }
            };
            search.addEventListener('input', paint);
            const actions = element('div', undefined, 'hosted-actions');
            actions.append(
              button(
                '全选搜索结果',
                () => {
                  const query = search.value.trim().toLowerCase();
                  candidates
                    .filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(query))
                    .forEach((model) => {
                      selected.add(model.id);
                    });
                  paint();
                },
                'btn btn-ghost btn-sm',
              ),
              button(
                '清空选择',
                () => {
                  selected.clear();
                  paint();
                },
                'btn btn-ghost btn-sm',
              ),
              button(
                '添加所选',
                () => {
                  for (const row of [...rows.children]) {
                    if (
                      !row.querySelector('[data-model-field="id"]').value.trim() &&
                      !row.querySelector('[data-model-field="name"]').value.trim()
                    )
                      row.remove();
                  }
                  const currentIds = new Set(readModels().map((model) => model.id));
                  candidates
                    .filter((model) => selected.has(model.id) && !currentIds.has(model.id))
                    .forEach((model) => {
                      addModel(newModel(model.id, model.name));
                    });
                  area.replaceChildren();
                },
                'btn btn-primary btn-sm',
              ),
            );
            area.replaceChildren(search, list, actions);
            paint();
          } catch {
            if (current())
              area.replaceChildren(element('p', '获取失败，请重试或手动添加模型。', 'muted'));
          } finally {
            input.apiKey = '';
            busy = false;
            if (current() && form.isConnected) form.querySelector('fieldset').disabled = false;
          }
        },
        'btn btn-ghost btn-sm',
      ),
    );
    form.querySelector('[data-cancel]').addEventListener('click', () => {
      if (!busy) {
        key.value = '';
        activeEditor = undefined;
        render();
        status.textContent = '';
      }
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy || !current()) return;
      form.querySelectorAll('input:invalid').forEach((input) => {
        const row = input.closest('.ai-model-row');
        if (row) row.open = true;
        form.querySelector('.ai-provider-options').open = true;
      });
      if (!form.reportValidity()) return;
      if (!rows.children.length) {
        status.textContent = '请至少添加一个模型。';
        return;
      }
      const input = {
        action: 'save-provider',
        revision,
        provider: {
          id: fields.namedItem('providerId').value.trim(),
          name: fields.namedItem('providerName').value.trim(),
          baseURL: fields.namedItem('baseURL').value.trim(),
          models: readModels(),
        },
        apiKey: key.value,
        clearApiKey: fields.namedItem('clearApiKey').checked,
      };
      key.value = '';
      hideKey();
      await apply(input, form);
    });
    activeEditor = form;
    card.append(form);
    status.textContent = '';
    fields.namedItem(creating ? 'providerId' : 'apiKey').focus();
  };

  const render = () => {
    box.replaceChildren();
    const heading = element('div', undefined, 'hosted-ai-heading');
    const title = element('div');
    title.append(
      element('h2', 'AI 模型'),
      element('p', '管理模型提供商，选择对话与研究使用的默认模型。', 'muted'),
    );
    heading.append(
      title,
      element('span', view.settings.enabled ? 'AI 已启用' : 'AI 未启用', 'hosted-ai-state'),
    );
    box.append(heading);
    const defaults = element('form', undefined, 'ai-default-model');
    defaults.noValidate = true;
    defaults.innerHTML = `<fieldset><div class="ai-model-list-heading"><h3>默认模型</h3><label class="hosted-check"><input name="enabled" type="checkbox">启用 AI</label></div><label class="field">对话与研究<select name="selection" aria-label="默认模型"></select></label><details><summary>费用预算</summary><div class="hosted-ai-grid"><label class="field">单次预算（元）<input name="callBudget" type="number" required min="0.000001" max="1000" step="0.000001"></label><label class="field">每用户订阅周期预算（元）<input name="periodBudget" type="number" required min="0.000001" max="10000" step="0.000001"></label></div></details><div class="hosted-actions"><button class="btn btn-primary" type="submit">应用默认模型</button></div></fieldset>`;
    const selection = defaults.elements.namedItem('selection');
    const placeholder = element('option', '请选择已配置的模型');
    placeholder.value = '';
    selection.append(placeholder);
    for (const provider of view.providers)
      for (const model of provider.models) {
        const readiness = !provider.apiKeyConfigured
          ? ' · 未配置密钥'
          : model.inputPrice <= 0 || model.outputPrice <= 0
            ? ' · 待填写费率'
            : '';
        const option = element('option', `${provider.name} / ${model.name}${readiness}`);
        option.value = JSON.stringify([provider.id, model.id]);
        selection.append(option);
      }
    selection.value = JSON.stringify([view.settings.provider, view.settings.model]);
    defaults.elements.namedItem('enabled').checked = view.settings.enabled;
    defaults.elements.namedItem('callBudget').value = view.settings.callBudget;
    defaults.elements.namedItem('periodBudget').value = view.settings.periodBudget;
    defaults.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (defaults.querySelector('input:invalid')) defaults.querySelector('details').open = true;
      if (!defaults.reportValidity()) return;
      const [providerId, modelId] = selection.value ? JSON.parse(selection.value) : ['', ''];
      if (
        await apply(
          {
            action: 'select-model',
            revision: view.revision,
            providerId,
            modelId,
            enabled: defaults.elements.namedItem('enabled').checked,
            callBudget: Number(defaults.elements.namedItem('callBudget').value),
            periodBudget: Number(defaults.elements.namedItem('periodBudget').value),
          },
          defaults,
        )
      )
        status.textContent = view.settings.enabled
          ? '默认模型已应用，后续 AI 请求使用新配置。'
          : 'AI 已停用，供应商配置已保留。';
    });
    box.append(defaults);
    const providersHeading = element('div', undefined, 'ai-model-list-heading');
    providersHeading.append(
      element('h3', '模型提供商'),
      element('span', `${view.providers.length} 个已配置`, 'muted'),
    );
    box.append(providersHeading);
    for (const provider of view.providers) {
      const card = element('section', undefined, 'ai-provider-card');
      const row = element('div', undefined, 'ai-provider-row');
      const identity = element('div');
      identity.append(
        element('strong', provider.name),
        element('p', `${provider.id} · ${provider.models.length} 个模型`, 'muted'),
      );
      const actions = element('div', undefined, 'hosted-actions');
      actions.append(
        element(
          'span',
          provider.apiKeyConfigured ? '密钥已配置' : '未配置密钥',
          `ai-provider-credential${provider.apiKeyConfigured ? ' configured' : ''}`,
        ),
      );
      actions.append(
        button('编辑', () => editor(provider, card, defaults), 'btn btn-ghost btn-sm'),
      );
      actions.append(
        button(
          '移除',
          () => {
            if (activeEditor || busy) return;
            const confirm = element('form', undefined, 'ai-provider-editor');
            const fieldset = element('fieldset');
            fieldset.append(element('p', `移除“${provider.name}”及其模型和已保存的密钥？`));
            fieldset.append(
              button(
                '确认移除',
                () =>
                  apply(
                    { action: 'remove-provider', providerId: provider.id, revision: view.revision },
                    confirm,
                  ),
                'btn btn-ghost',
              ),
              button('取消', () => {
                activeEditor = undefined;
                render();
              }),
            );
            confirm.append(fieldset);
            activeEditor = confirm;
            defaults.querySelector('fieldset').disabled = true;
            box
              .querySelectorAll('.ai-provider-row button, .ai-provider-add > button')
              .forEach((node) => {
                node.disabled = true;
              });
            card.append(confirm);
          },
          'btn btn-ghost btn-sm',
        ),
      );
      row.append(identity, actions);
      card.append(row);
      box.append(card);
    }
    if (!view.providers.length)
      box.append(element('p', '还没有模型提供商。添加供应商后，填写密钥并配置模型。', 'muted'));
    const addCard = element('section', undefined, 'ai-provider-add');
    addCard.append(
      button('＋ 添加模型提供商', () => editor(undefined, addCard, defaults), 'btn btn-ghost'),
    );
    box.append(addCard, status);
    const foot = element(
      'p',
      '管理员设置 · 对所有用户生效。保存配置不会调用模型；获取模型列表只读取供应商目录，不代表对话连接已验证。',
      'muted',
    );
    box.append(
      foot,
      button(
        '重新载入配置（放弃草稿）',
        () => {
          if (!busy) renderHostedAISettings(box);
        },
        'btn btn-ghost btn-sm',
      ),
    );
  };
  render();
};
