import { createElement as h, useEffect, useRef, useState } from 'react';
import { dataOf, errorOf, usePanelState } from './data.js';
import { diagnosticRows, diagnosticsSummary } from './diagnostics.js';
import { clock, money, when } from './format.js';
import {
  backupSummary,
  canReuseSession,
  clearImportSession,
  digestLabel,
  IMPORT_MODE,
  importDecision,
  importLimitations,
  importReceipt,
  previewTableRows,
  readImportSession,
  structuralOnlyTables,
  writeImportSession,
} from './import-preview.js';
import {
  Card,
  ErrorNote,
  Footer,
  Head,
  Panel,
  Pill,
  Refresh,
  Section,
  Stamp,
  Stat,
} from './primitives.js';

const operationRequest = async (path, body) => {
  const response = await fetch(`api/luoome/operations/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(result.error?.message ?? result.error?.kind ?? `HTTP ${response.status}`);
  return result.data;
};

const marketRequest = async (body, signal) => {
  const response = await fetch('api/luoome/settings/market', {
    method: body === undefined ? 'GET' : 'POST',
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(result.error?.message ?? result.error?.cause ?? '行情设置暂时无法保存');
  return result.data;
};

function MarketSettingsForm({ refreshKey, onSaved }) {
  const [data, setData] = useState(null);
  const [sources, setSources] = useState(['', '', '']);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  /** 按源收集的密钥输入（非 FUYAO 的其它凭据源）；空串 = 保留。 */
  const [keys, setKeys] = useState({});
  const [paths, setPaths] = useState({});
  const [advanced, setAdvancedState] = useState({});
  const [vaultIds, setVaultIds] = useState({});
  /** 按源收集的显式清空开关（clear:true 才会删密钥）。 */
  const [clears, setClears] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    marketRequest(undefined, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setData(next);
        setSources(Array.from({ length: 3 }, (_, index) => next.activeOrder[index] ?? ''));
        setBaseUrl(next.fuyao.baseUrl);
        setError('');
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [refreshKey]);

  const selected = sources.filter(Boolean);
  const duplicate = new Set(selected).size !== selected.length;
  // 凭据分区从服务端 `credentials` 派生（REQ-M3-15）：用户新增一家源，这里自动多一格。
  const credentialSections = data?.credentials ?? [];
  const apiKeyFor = (id) => keys[id] ?? '';
  // 本机路径（task-33）：本地状态，初值取服务端回显的 path / vaultId（它们不是秘密）。
  const serverPath = (id) => credentialSections.find((section) => section.id === id)?.path ?? '';
  const serverVaultId = (id) =>
    credentialSections.find((section) => section.id === id)?.vaultId ?? '';
  const pathsFor = (id) => paths[id] ?? serverPath(id);
  // 高级配置（task-33）：研究目录 / 受管目录 / 文本上限 / 附件上限。同样从服务端回显（含默认值）。
  const advancedFor = (id, field) => {
    const draft = advanced[id]?.[field];
    if (draft !== undefined) return draft;
    const section = credentialSections.find((item) => item.id === id);
    return section?.[field] ?? '';
  };
  const setAdvanced = (id, field, value) =>
    setAdvancedState((current) => ({
      ...current,
      [id]: { ...(current[id] ?? {}), [field]: value },
    }));
  const vaultIdsFor = (id) => vaultIds[id] ?? serverVaultId(id);
  const clearFor = (id) => clears[id] === true;
  const setKey = (id, value) => setKeys((current) => ({ ...current, [id]: value }));
  const setClear = (id, value) => setClears((current) => ({ ...current, [id]: value }));
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setError('');
    try {
      // 按 `kind` 分流（task-32）：行情源凭据走 `credentials`，通知通道走 `notifications`。
      // **不按 id 特判**——新增一个通道时这段不用改。
      const notificationSections = credentialSections.filter(
        (section) => section.kind === 'notification-channel',
      );
      // 本机路径配置（task-33）：走 `localPaths`，与凭据/通知分开。
      const localPathSections = credentialSections.filter(
        (section) => section.kind === 'local-path',
      );
      const credentials = Object.fromEntries(
        credentialSections
          .filter((section) => section.kind === 'market-source' && section.id !== 'fuyao')
          .map((section) => {
            const key = apiKeyFor(section.id).trim();
            const clear = clearFor(section.id);
            return [
              section.id,
              { ...(key.length > 0 ? { apiKey: key } : {}), ...(clear ? { clear: true } : {}) },
            ];
          }),
      );
      const next = await marketRequest({
        sources: selected,
        fuyao: {
          baseUrl: baseUrl.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(clearFor('fuyao') ? { clear: true } : {}),
        },
        credentials,
        ...(notificationSections.length === 0
          ? {}
          : {
              notifications: Object.fromEntries(
                notificationSections.map((section) => {
                  const value = apiKeyFor(section.id).trim();
                  const clear = clearFor(section.id);
                  return [
                    section.id,
                    {
                      ...(value.length > 0 ? { webhookUrl: value } : {}),
                      ...(clear ? { clearWebhook: true } : {}),
                    },
                  ];
                }),
              ),
            }),
        ...(localPathSections.length === 0
          ? {}
          : {
              localPaths: Object.fromEntries(
                localPathSections.map((section) => {
                  const value = String(pathsFor(section.id) ?? '').trim();
                  const vaultId = String(vaultIdsFor(section.id) ?? '').trim();
                  const clear = clearFor(section.id);
                  const researchRoot = String(advancedFor(section.id, 'researchRoot') ?? '').trim();
                  const managedRoot = String(advancedFor(section.id, 'managedRoot') ?? '').trim();
                  const maxTextMb = String(advancedFor(section.id, 'maxTextMb') ?? '').trim();
                  const maxAttachmentMb = String(
                    advancedFor(section.id, 'maxAttachmentMb') ?? '',
                  ).trim();
                  return [
                    section.id,
                    {
                      ...(value.length > 0 ? { path: value } : {}),
                      ...(vaultId.length > 0 ? { vaultId } : {}),
                      ...(researchRoot.length > 0 ? { researchRoot } : {}),
                      ...(managedRoot.length > 0 ? { managedRoot } : {}),
                      ...(maxTextMb.length > 0 ? { maxTextMb: Number(maxTextMb) } : {}),
                      ...(maxAttachmentMb.length > 0
                        ? { maxAttachmentMb: Number(maxAttachmentMb) }
                        : {}),
                      ...(clear ? { clearVault: true } : {}),
                    },
                  ];
                }),
              ),
            }),
      });
      setData(next);
      setBaseUrl(next.fuyao.baseUrl);
      setApiKey('');
      setKeys({});
      setClears({});
      setMessage('行情设置已保存，立即生效');
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return h(
    Section,
    { title: '行情数据源' },
    h(
      Card,
      {
        title: 'FUYAO（同花顺）',
        meta: data
          ? h(
              Pill,
              { tone: data.activeOrder.includes('fuyao') ? 'ok' : 'quiet' },
              data.activeOrder.includes('fuyao') ? '已启用' : '未启用',
            )
          : null,
      },
      h(
        'p',
        { className: 'luo-fine' },
        '提供行情快照、前复权日线、股票检索与指数。将 FUYAO 加入下方优先级后启用。',
      ),
      error ? h(ErrorNote, { error }) : null,
      data
        ? h(
            'form',
            { className: 'luo-form', onSubmit: save },
            h(
              'label',
              { className: 'luo-field' },
              'FUYAO 服务地址',
              h('input', {
                type: 'url',
                'aria-label': 'FUYAO 服务地址',
                value: baseUrl,
                required: true,
                maxLength: 2048,
                disabled: busy,
                onChange: (event) => setBaseUrl(event.target.value),
              }),
            ),
            h(
              'label',
              { className: 'luo-field' },
              `FUYAO API Key · ${data.fuyao.configured ? '已配置' : '未配置'}`,
              h('input', {
                type: 'password',
                'aria-label': 'FUYAO API Key',
                autoComplete: 'new-password',
                value: apiKey,
                maxLength: 4096,
                // 「启用 fuyao 但尚未配置密钥」时才必填；已配置留空 = 保留原密钥（REQ-M3-15）。
                required:
                  selected.includes('fuyao') && !data.fuyao.configured && !clearFor('fuyao'),
                placeholder: data.fuyao.configured ? '留空保留现有密钥' : '输入 API Key',
                disabled: busy,
                onChange: (event) => setApiKey(event.target.value),
              }),
            ),
            h('p', { className: 'luo-fine' }, '密钥仅保存在本机，保存后不回显。'),
            // 其它凭据格子：**从服务端 credentials 派生**，新增一家源/通道自动多一格。
            // 按 `kind` 决定走哪条分支（task-32），**不按 id 特判**。
            ...credentialSections
              .filter((section) => section.kind === 'market-source' && section.id !== 'fuyao')
              .map((section) =>
                h(
                  'div',
                  { key: section.id, 'data-credential-section': section.id },
                  h(
                    'label',
                    { className: 'luo-field' },
                    `${section.label} · ${section.configured ? '已配置' : '未配置'}`,
                    h('input', {
                      type: 'password',
                      'aria-label': `${section.label} API Key`,
                      autoComplete: 'new-password',
                      value: apiKeyFor(section.id),
                      maxLength: 4096,
                      required:
                        selected.includes(section.id) &&
                        !section.configured &&
                        !clearFor(section.id),
                      placeholder: section.configured ? '留空保留现有密钥' : '输入 API Key',
                      disabled: busy,
                      onChange: (event) => setKey(section.id, event.target.value),
                    }),
                  ),
                  section.configured
                    ? h(
                        'label',
                        { className: 'luo-fine' },
                        h('input', {
                          type: 'checkbox',
                          'aria-label': `清空 ${section.label} 密钥`,
                          checked: clearFor(section.id),
                          disabled: busy,
                          onChange: (event) => setClear(section.id, event.target.checked),
                        }),
                        ` 清空 ${section.envKey}（显式动作，留空不会清空）`,
                      )
                    : null,
                ),
              ),
            // 通知通道（task-32）：与行情源凭据同一个数组、不同 `kind`，渲染上单列一段。
            ...credentialSections
              .filter((section) => section.kind === 'notification-channel')
              .map((section) =>
                h(
                  'div',
                  { key: section.id, 'data-credential-section': section.id },
                  h(
                    'label',
                    { className: 'luo-field' },
                    `${section.label} · ${section.configured ? '已配置' : '未配置'}`,
                    h('input', {
                      type: 'password',
                      'aria-label': `${section.label} Webhook URL`,
                      autoComplete: 'new-password',
                      value: apiKeyFor(section.id),
                      maxLength: 2048,
                      placeholder: section.configured
                        ? '留空保留现有 Webhook'
                        : `https://${section.endpoint}/open-apis/bot/v2/hook/…`,
                      disabled: busy,
                      onChange: (event) => setKey(section.id, event.target.value),
                    }),
                  ),
                  h(
                    'p',
                    { className: 'luo-fine' },
                    `只接受 https://${section.endpoint} 的自定义机器人 Webhook；密钥仅保存在本机，保存后不回显。`,
                  ),
                  section.configured
                    ? h(
                        'label',
                        { className: 'luo-fine' },
                        h('input', {
                          type: 'checkbox',
                          'aria-label': `清空 ${section.label} Webhook`,
                          checked: clearFor(section.id),
                          disabled: busy,
                          onChange: (event) => setClear(section.id, event.target.checked),
                        }),
                        ` 清除 Webhook（显式动作，留空不会清空）`,
                      )
                    : null,
                ),
              ),
            // 本机路径配置（task-33）：普通文本框（路径不是秘密，可回显），显式清除才删键。
            ...credentialSections
              .filter((section) => section.kind === 'local-path')
              .map((section) =>
                h(
                  'div',
                  { key: section.id, 'data-credential-section': section.id },
                  h(
                    'label',
                    { className: 'luo-field' },
                    `${section.label} · ${section.configured ? '已配置' : '未配置'}`,
                    h('input', {
                      type: 'text',
                      'aria-label': `${section.label} 绝对路径`,
                      value: pathsFor(section.id),
                      maxLength: 4096,
                      placeholder: '/Users/you/Documents/Vault',
                      disabled: busy,
                      onChange: (event) =>
                        setPaths((current) => ({ ...current, [section.id]: event.target.value })),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'luo-field' },
                    '库 ID（可选，留空按路径自动生成）',
                    h('input', {
                      type: 'text',
                      'aria-label': `${section.label} 库 ID`,
                      value: vaultIdsFor(section.id),
                      maxLength: 256,
                      disabled: busy,
                      onChange: (event) =>
                        setVaultIds((current) => ({
                          ...current,
                          [section.id]: event.target.value,
                        })),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'luo-field' },
                    '研究目录（库内相对路径）',
                    h('input', {
                      type: 'text',
                      'aria-label': `${section.label} 研究目录`,
                      value: advancedFor(section.id, 'researchRoot'),
                      maxLength: 512,
                      disabled: busy,
                      onChange: (event) =>
                        setAdvanced(section.id, 'researchRoot', event.target.value),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'luo-field' },
                    '受管目录（库内相对路径）',
                    h('input', {
                      type: 'text',
                      'aria-label': `${section.label} 受管目录`,
                      value: advancedFor(section.id, 'managedRoot'),
                      maxLength: 512,
                      disabled: busy,
                      onChange: (event) =>
                        setAdvanced(section.id, 'managedRoot', event.target.value),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'luo-field' },
                    '单篇文本上限（MB）',
                    h('input', {
                      type: 'number',
                      min: 1,
                      max: 100,
                      'aria-label': `${section.label} 文本上限 MB`,
                      value: advancedFor(section.id, 'maxTextMb'),
                      disabled: busy,
                      onChange: (event) => setAdvanced(section.id, 'maxTextMb', event.target.value),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'luo-field' },
                    '单个附件上限（MB）',
                    h('input', {
                      type: 'number',
                      min: 1,
                      max: 1024,
                      'aria-label': `${section.label} 附件上限 MB`,
                      value: advancedFor(section.id, 'maxAttachmentMb'),
                      disabled: busy,
                      onChange: (event) =>
                        setAdvanced(section.id, 'maxAttachmentMb', event.target.value),
                    }),
                  ),
                  h(
                    'p',
                    { className: 'luo-fine' },
                    '路径必须是已存在的绝对目录；两个目录是库内相对路径。留空不会清空。',
                  ),
                  section.configured
                    ? h(
                        'label',
                        { className: 'luo-fine' },
                        h('input', {
                          type: 'checkbox',
                          'aria-label': `清空 ${section.label}`,
                          checked: clearFor(section.id),
                          disabled: busy,
                          onChange: (event) => setClear(section.id, event.target.checked),
                        }),
                        ` 清除研究库配置（显式动作，留空不会清空）`,
                      )
                    : null,
                ),
              ),
            h(
              'div',
              { className: 'luo-source-order' },
              sources.map((source, index) =>
                h(
                  'label',
                  { key: index, className: 'luo-field' },
                  index === 0 ? '首选行情源' : `备用行情源 ${index}`,
                  h(
                    'select',
                    {
                      'aria-label': `行情源优先级 ${index + 1}`,
                      value: source,
                      disabled: busy,
                      onChange: (event) =>
                        setSources((current) =>
                          current.map((value, position) =>
                            position === index ? event.target.value : value,
                          ),
                        ),
                    },
                    h('option', { value: '' }, '不启用'),
                    data.sources.map((item) =>
                      h('option', { key: item.id, value: item.id }, item.label),
                    ),
                  ),
                ),
              ),
            ),
            h(
              'p',
              { className: 'luo-fine' },
              duplicate
                ? '行情源不能重复，请调整优先级。'
                : '最多启用三个行情源，按优先级依次尝试。',
            ),
            h(
              'div',
              { className: 'luo-actions' },
              h(
                'button',
                {
                  type: 'submit',
                  className: 'luo-btn',
                  disabled: busy || duplicate || selected.length === 0,
                },
                busy ? '保存中' : '保存行情设置',
              ),
              message ? h('span', { role: 'status', className: 'luo-fine' }, message) : null,
            ),
          )
        : !error
          ? h('p', { role: 'status', className: 'luo-fine' }, '读取行情设置…')
          : null,
    ),
  );
}

function AccountNameForm({ account, enabled, onSaved }) {
  const [name, setName] = useState(account.name);
  const [pending, setPending] = useState(() => {
    const id = sessionStorage.getItem(`luoome-account-operation:${account.id}`);
    return id ? { operationId: id, state: 'unknown' } : null;
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const act = async (action) => {
    setBusy(true);
    setMessage('');
    let operation = pending;
    try {
      if (action === 'prepare') {
        operation = { operationId: crypto.randomUUID(), state: 'preparing' };
        sessionStorage.setItem(`luoome-account-operation:${account.id}`, operation.operationId);
        setPending(operation);
        operation = await operationRequest('prepare', {
          id: operation.operationId,
          tool: 'update_account',
          input: { accountId: account.id, name: name.trim() },
        });
      } else if (action === 'check') {
        operation = await operationRequest(encodeURIComponent(operation.operationId));
        if (operation.state === 'executing' || operation.state === 'unknown')
          operation = await operationRequest(
            `${encodeURIComponent(operation.operationId)}/reconcile`,
            {},
          );
      } else {
        operation = await operationRequest(
          `${encodeURIComponent(operation.operationId)}/${action}`,
          { token: operation.confirmationToken },
        );
      }
      setPending(operation);
      if (operation.state === 'succeeded') {
        setMessage('账户名称已保存');
        onSaved();
      } else if (operation.state === 'cancelled') setMessage('已取消，账户未修改');
      else if (operation.state === 'unknown' || operation.state === 'executing')
        setMessage('结果尚未明确，请核对结果后再操作。');
    } catch (error) {
      if (action === 'confirm')
        setPending({ ...operation, state: 'unknown', confirmationToken: null });
      setMessage(`${error.message}；可核对操作结果，避免重复提交。`);
    } finally {
      setBusy(false);
    }
  };
  const confirming = pending?.state === 'pending' && pending.confirmationToken;
  return h(
    'div',
    { className: 'luo-form' },
    h(
      'label',
      { className: 'luo-field' },
      '账户名称',
      h('input', {
        name: 'account-name',
        value: name,
        maxLength: 120,
        required: true,
        disabled: busy || confirming,
        onChange: (event) => setName(event.target.value),
      }),
    ),
    confirming
      ? h(
          'div',
          { className: 'luo-confirm', role: 'group', 'aria-label': '确认账户名称' },
          h('strong', null, `将「${account.name}」改为「${pending.input.name}」`),
          h('p', { className: 'luo-fine' }, `仅修改名称 · 有效期至 ${when(pending.expiresAt)}`),
          h(
            'div',
            { className: 'luo-actions' },
            h(
              'button',
              {
                className: 'luo-btn',
                type: 'button',
                disabled: busy,
                onClick: () => act('confirm'),
              },
              '确认保存',
            ),
            h(
              'button',
              {
                className: 'luo-btn',
                type: 'button',
                disabled: busy,
                onClick: () => act('cancel'),
              },
              '取消',
            ),
          ),
        )
      : h(
          'button',
          {
            className: 'luo-btn',
            type: 'button',
            disabled:
              busy ||
              !enabled ||
              !name.trim() ||
              name.trim() === account.name ||
              ['unknown', 'executing', 'preparing'].includes(pending?.state),
            onClick: () => act('prepare'),
          },
          busy ? '处理中' : '保存修改',
        ),
    pending?.operationId
      ? h(
          'div',
          { className: 'luo-fine luo-operation-ref' },
          h('span', null, `操作 ${pending.operationId}`),
          h(
            'button',
            { className: 'luo-btn', type: 'button', disabled: busy, onClick: () => act('check') },
            '核对结果',
          ),
          pending.state === 'preparing'
            ? h(
                'button',
                {
                  className: 'luo-btn',
                  type: 'button',
                  disabled: busy,
                  onClick: () => {
                    setPending(null);
                    sessionStorage.removeItem(`luoome-account-operation:${account.id}`);
                  },
                },
                '放弃未提交草案',
              )
            : null,
        )
      : null,
    message ? h('p', { role: 'status', className: 'luo-fine' }, message) : null,
  );
}

const importPreviewRequest = async (uploadId) => {
  const response = await fetch('api/luoome/import/preview', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(result.error?.message ?? result.error?.kind ?? `HTTP ${response.status}`);
  return result.data;
};

const importBackupRequest = async (uploadId) => {
  const response = await fetch('api/luoome/import/backup', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(result.error?.message ?? result.error?.cause ?? `HTTP ${response.status}`);
  return result.data;
};

const importUploadRequest = async (file) => {
  const response = await fetch('api/luoome/import/upload', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(result.error?.message ?? result.error?.kind ?? `HTTP ${response.status}`);
  return result.data;
};

function DataImportForm({ accountId, enabled }) {
  const [upload, setUpload] = useState(null);
  const [preview, setPreview] = useState(null);
  // 备份由服务端生成并绑定 targetDigest；不是勾选框。
  const [backup, setBackup] = useState(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [session, setSession] = useState(() => readImportSession(sessionStorage));
  // 同步闸门：React 状态在同一 tick 内尚未生效，双击只能靠 ref 挡住第二次提交。
  const inFlight = useRef(false);

  // 刷新后回执可读：只按 sessionStorage 里的 operationId 回读，不依赖暂存文件。
  useEffect(() => {
    const current = readImportSession(sessionStorage);
    if (!current) return;
    let alive = true;
    operationRequest(encodeURIComponent(current.operationId))
      .then((operation) => {
        if (!alive) return;
        const summary = importReceipt(operation);
        setReceipt(summary);
        const next = { ...current, state: summary.state };
        setSession(next);
        writeImportSession(sessionStorage, next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const choose = async (selected) => {
    setUpload(null);
    setPreview(null);
    setBackup(null);
    setReceipt(null);
    setError('');
    setMessage('');
    if (!selected) return;
    setBusy(true);
    try {
      const uploaded = await importUploadRequest(selected);
      setUpload(uploaded);
      const result = await importPreviewRequest(uploaded.uploadId);
      setPreview(result);
      setMessage(
        `预检完成：${Object.keys(result.counts ?? {}).length} 张表，快照 ${digestLabel(uploaded.archiveDigest)}`,
      );
    } catch (err) {
      setError(err.message);
      setUpload(null);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const requestBackup = async () => {
    if (!upload || backupBusy) return;
    setBackupBusy(true);
    setError('');
    setMessage('');
    try {
      const created = await importBackupRequest(upload.uploadId);
      setBackup(created);
      setMessage('已生成恢复前一致性备份，可以提交恢复。');
    } catch (err) {
      setBackup(null);
      setError(`备份失败：${err.message}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const submit = async () => {
    if (inFlight.current || !upload || !preview || !backup) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    setMessage('');
    // 每次提交都是新 operationId；failed 之后绝不复用旧 id。
    const operationId = crypto.randomUUID();
    const pending = {
      operationId,
      requestId: operationId,
      archiveDigest: preview.archiveDigest,
      previewHash: preview.previewHash,
      state: 'preparing',
    };
    writeImportSession(sessionStorage, pending);
    setSession(pending);
    try {
      const operation = await operationRequest('prepare', {
        id: operationId,
        tool: 'restore_data_import',
        input: {
          uploadId: upload.uploadId,
          previewHash: preview.previewHash,
          previewExpiresAt: preview.expiresAt,
          backupId: backup.backupId,
          mode: IMPORT_MODE,
        },
      });
      const summary = importReceipt(operation);
      setReceipt(summary);
      if (summary.state === 'failed') {
        // failed 是终态：清掉本地 id 与本次备份，要求重新预检 + 重新备份 + 新 operationId。
        clearImportSession(sessionStorage);
        setSession(null);
        setBackup(null);
        setMessage(
          `提交被拒：${summary.error || '恢复条件不满足'}。请重新预检并重新生成备份后再提交（旧操作号与旧备份不可复用）。`,
        );
      } else {
        const next = { ...pending, state: summary.state };
        writeImportSession(sessionStorage, next);
        setSession(next);
        setMessage(
          summary.state === 'succeeded'
            ? '业务快照已恢复。请刷新面板或重启插件以读取新数据。'
            : '结果尚未明确，请点击「核对结果」。',
        );
      }
    } catch (err) {
      setError(err.message);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const check = async () => {
    const current = readImportSession(sessionStorage);
    if (!current) return;
    setBusy(true);
    setError('');
    try {
      let operation = await operationRequest(encodeURIComponent(current.operationId));
      if (operation.state === 'executing' || operation.state === 'unknown')
        operation = await operationRequest(
          `${encodeURIComponent(current.operationId)}/reconcile`,
          {},
        );
      const summary = importReceipt(operation);
      setReceipt(summary);
      const next = { ...current, state: summary.state };
      setSession(next);
      writeImportSession(sessionStorage, next);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const decision = importDecision({ preview, backup, busy, submitting });
  const backupInfo = backupSummary(backup);
  const rows = previewTableRows(preview);
  const structural = structuralOnlyTables(preview);
  const limitations = importLimitations(preview);

  return h(
    Card,
    {
      title: '恢复业务快照（SQLite）',
      meta: h(Pill, { tone: enabled ? 'ok' : 'quiet' }, enabled ? '可用' : '未启用恢复策略'),
    },
    h(
      'p',
      { className: 'luo-fine' },
      '选择一份关闭后或一致性 backup 生成的 luoome SQLite 快照。上传只走专用二进制载体，普通接口不承载数据库；预检只读，不写目标库。',
    ),
    error ? h(ErrorNote, { error }) : null,
    h(
      'label',
      { className: 'luo-field' },
      '快照文件',
      h('input', {
        type: 'file',
        'aria-label': '快照文件',
        accept: '.db,.sqlite,.sqlite3,application/octet-stream',
        disabled: busy || submitting || !enabled,
        onChange: (event) => choose(event.target.files?.[0] ?? null),
      }),
    ),
    busy ? h('p', { role: 'status', className: 'luo-fine' }, '上传并预检中…') : null,
    upload
      ? h(
          'p',
          { className: 'luo-fine' },
          `暂存 ${digestLabel(upload.archiveDigest)} · ${Math.round(upload.size / 1024)} KiB · 预检有效期至 ${when(preview?.expiresAt ?? upload.expiresAt)}`,
        )
      : null,
    preview
      ? h(
          'div',
          null,
          h(
            'div',
            { className: 'luo-substats' },
            h(Stat, { k: '格式', v: 'SQLite 业务快照' }),
            h(Stat, { k: '模式', v: preview.mode ?? IMPORT_MODE }),
            h(Stat, { k: 'owner', v: accountId ?? '—' }),
            h(Stat, { k: '表数', v: String(rows.length) }),
          ),
          h(
            'div',
            { className: 'luo-table-wrap' },
            h(
              'table',
              { className: 'luo-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '表'),
                  h('th', null, '策略'),
                  h('th', null, '校验'),
                  h('th', null, '来源'),
                  h('th', null, '当前'),
                  h('th', null, '预计'),
                  h('th', null, '增/改/删'),
                ),
              ),
              h(
                'tbody',
                null,
                rows.map((row) =>
                  h(
                    'tr',
                    { key: row.table },
                    h('td', null, row.table),
                    h('td', null, row.policy),
                    h('td', null, row.validation === 'domain' ? '领域' : '仅结构'),
                    h('td', null, row.source),
                    h('td', null, row.current),
                    h('td', null, row.expected),
                    h('td', null, row.delta),
                  ),
                ),
              ),
            ),
          ),
          structural.length > 0
            ? h(
                'div',
                { className: 'luo-fine', role: 'note' },
                h('strong', null, `仅做结构校验的 ${structural.length} 张表：`),
                h('span', null, structural.join('、')),
                h(
                  'p',
                  null,
                  '这些表只校验主键存在、布尔列 0/1、JSON 列可解析与枚举取值，不校验领域不变量。恢复不重新推导任何事实。',
                ),
              )
            : null,
          limitations.length > 0
            ? h(
                'ul',
                { className: 'luo-setting-list' },
                limitations.map((item, index) => h('li', { key: index }, item)),
              )
            : null,
        )
      : null,
    h(
      'div',
      { className: 'luo-actions' },
      h(
        'button',
        {
          className: 'luo-btn',
          type: 'button',
          'aria-label': '生成恢复前备份',
          disabled: !preview || busy || submitting || backupBusy,
          onClick: requestBackup,
        },
        backupBusy ? '备份中…' : backupInfo ? '重新生成备份' : '生成恢复前备份',
      ),
      backupInfo
        ? h(
            'span',
            { role: 'status', className: 'luo-fine', 'data-backup-id': backupInfo.backupId },
            `备份 ${backupInfo.digest} · ${backupInfo.size} KiB · ${when(backupInfo.createdAt)}`,
          )
        : h('span', { className: 'luo-fine' }, '提交前必须由服务端生成一致性备份'),
    ),
    h(
      'p',
      { className: 'luo-fine' },
      '服务端只保留最近 10 份备份，更早的会被清理；需要长期留存请自行导出该备份文件。',
    ),
    h(
      'div',
      { className: 'luo-actions' },
      h(
        'button',
        {
          className: 'luo-btn',
          type: 'button',
          disabled: decision.disabled || !enabled,
          onClick: submit,
        },
        submitting ? '提交中…' : '恢复业务快照',
      ),
      h(
        'button',
        {
          className: 'luo-btn',
          type: 'button',
          disabled: true,
          title: '旧 JSON 分类合并由后续切片提供',
          'aria-describedby': 'luo-import-merge-note',
        },
        '合并分类数据',
      ),
      decision.reason ? h('span', { className: 'luo-fine' }, decision.reason) : null,
    ),
    h(
      'p',
      { className: 'luo-fine', id: 'luo-import-merge-note' },
      '旧 JSON 分类合并（合并分类数据）为后续切片，本版本不提供；当前只支持 SQLite 业务快照恢复。',
    ),
    message ? h('p', { role: 'status', className: 'luo-fine' }, message) : null,
    receipt
      ? h(
          'div',
          { className: 'luo-fine luo-operation-ref' },
          h('span', null, `操作 ${receipt.operationId} · ${receipt.state}`),
          receipt.requestId ? h('span', null, `回执 ${receipt.requestId}`) : null,
          receipt.archiveDigest
            ? h('span', null, `快照 ${digestLabel(receipt.archiveDigest)}`)
            : null,
          receipt.committedAt ? h('span', null, `提交于 ${when(receipt.committedAt)}`) : null,
          receipt.error ? h('span', null, receipt.error) : null,
          Object.keys(receipt.actual ?? {}).length > 0
            ? h(
                'span',
                null,
                `回读 ${Object.entries(receipt.actual)
                  .filter(([, count]) => count > 0)
                  .map(([table, count]) => `${table}=${count}`)
                  .join('，')}`,
              )
            : null,
        )
      : null,
    session?.operationId && canReuseSession(session)
      ? h(
          'div',
          { className: 'luo-fine luo-operation-ref' },
          h('span', null, `上次操作 ${session.operationId}（${session.state}）`),
          h(
            'button',
            { className: 'luo-btn', type: 'button', disabled: busy, onClick: check },
            '核对结果',
          ),
        )
      : null,
    h(
      'p',
      { className: 'luo-fine' },
      '浏览器只保存操作号与摘要，不保存凭证或原始文件；提交失败后必须重新预检并使用新的操作号。',
    ),
  );
}

function DiagnosticsSection({ diagnostics, error }) {
  const summary = diagnosticsSummary(diagnostics);
  const rows = diagnosticRows(diagnostics);
  return h(
    Section,
    {
      title: '诊断',
      id: 'diagnostics',
      meta: h(Pill, { tone: summary.tone }, summary.text),
    },
    h(
      Card,
      { title: '数据诊断', meta: h('span', { className: 'luo-fine' }, '只读 · 不探测上游') },
      h(
        'p',
        { className: 'luo-fine' },
        '每条结论都给出具体表名、字段与日期；缺失日期显示「从未」，不推断时间。',
      ),
      error ? h(ErrorNote, { label: '诊断', error }) : null,
      rows.length === 0
        ? h('p', { role: 'status', className: 'luo-fine' }, '未发现数据问题。')
        : h(
            'ul',
            { className: 'luo-setting-list' },
            rows.map((row) =>
              h(
                'li',
                { key: row.key, 'data-diagnostic-code': row.code },
                h(
                  'span',
                  null,
                  h(Pill, { tone: row.severity }, row.label),
                  h('span', { className: 'luo-diagnostic-subject' }, `${row.subject} · ${row.at}`),
                  h('span', { className: 'luo-fine' }, row.message),
                ),
              ),
            ),
          ),
    ),
  );
}

export function SettingsPanel() {
  const state = usePanelState('settings');
  // section 深链：settings?section=diagnostics / #diagnostics 直接定位到诊断区块。
  useEffect(() => {
    const wanted =
      new URLSearchParams(window.location.search).get('section') ??
      window.location.hash.replace(/^#/, '');
    if (wanted !== 'diagnostics') return;
    document
      .querySelector('[data-luoome-section="diagnostics"]')
      ?.scrollIntoView({ block: 'start' });
  }, []);
  const account = dataOf(state.results, 'get_account')?.account;
  const health = dataOf(state.results, 'get_market_data_status');
  const universe = dataOf(state.results, 'get_stock_universe_status');
  const config = state.configuration;
  const policies = config?.policies ?? [];
  return h(
    Panel,
    { className: 'luo-settings' },
    h(Head, {
      eyebrow: 'Workspace settings',
      title: '投资设置',
      subtitle: '管理账户、行情数据源与自动任务',
      side: h(Refresh, { loading: state.loading, onClick: state.refresh }),
    }),
    state.panelError ? h(ErrorNote, { label: '设置', error: state.panelError }) : null,
    h(MarketSettingsForm, { refreshKey: state.asOf, onSaved: state.refresh }),
    h(
      Section,
      { title: '当前账户' },
      h(
        Card,
        { title: account?.name ?? '读取账户', meta: account?.id },
        errorOf(state.results, 'get_account')
          ? h(ErrorNote, { label: '账户', error: errorOf(state.results, 'get_account') })
          : null,
        account
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'luo-substats' },
                h(Stat, { k: '币种', v: account.currency }),
                h(Stat, { k: '开户本金', v: money(account.initialCapital) }),
                h(Stat, { k: '账面现金', v: money(account.cashBalance) }),
              ),
              h(AccountNameForm, {
                key: account.id,
                account,
                enabled: policies.some((item) => item.name === 'update_account'),
                onSaved: state.refresh,
              }),
            )
          : null,
      ),
    ),
    h(
      Section,
      {
        title: '数据恢复',
        meta: h(
          Pill,
          { tone: policies.some((item) => item.name === 'restore_data_import') ? 'warn' : 'quiet' },
          policies.some((item) => item.name === 'restore_data_import') ? '替换业务事实' : '未启用',
        ),
      },
      h(DataImportForm, {
        accountId: config?.accountId,
        enabled: policies.some((item) => item.name === 'restore_data_import'),
      }),
    ),
    h(
      Section,
      { title: '数据健康' },
      h(
        'div',
        { className: 'luo-grid is-two' },
        h(
          Card,
          { title: '行情', meta: health?.marketSession },
          errorOf(state.results, 'get_market_data_status')
            ? h(ErrorNote, {
                label: '行情状态',
                error: errorOf(state.results, 'get_market_data_status'),
              })
            : null,
          h(
            'p',
            { className: 'luo-fine' },
            '市场休市时显示最近交易日事实；供应商不可用时保留缺失说明。',
          ),
          h('p', { className: 'luo-fine' }, health?.warnings?.join('；')),
        ),
        h(
          Card,
          { title: '股票库' },
          errorOf(state.results, 'get_stock_universe_status')
            ? h(ErrorNote, {
                label: '股票库',
                error: errorOf(state.results, 'get_stock_universe_status'),
              })
            : null,
          h('p', null, `${universe?.activeCount ?? '—'} 只有效标的`),
          h('p', { className: 'luo-fine' }, '范围与完整性由实际同步事实决定。'),
        ),
      ),
    ),
    h(DiagnosticsSection, {
      diagnostics: dataOf(state.results, 'get_data_diagnostics'),
      error: errorOf(state.results, 'get_data_diagnostics'),
    }),
    h(
      Section,
      {
        title: '自动任务',
        meta: h(
          Pill,
          { tone: config?.automationsEnabled ? 'ok' : 'quiet' },
          config?.automationsEnabled ? '已启用授权执行' : '自动执行关闭',
        ),
      },
      h(
        Card,
        null,
        h(
          'p',
          null,
          '自动任务由 DSH 的「自动化任务」管理时间和会话。每项批处理仍绑定对应账户、工具、参数和有效期。',
        ),
        h(
          'p',
          { className: 'luo-fine' },
          config?.automationsEnabled
            ? '可在对话中读取任务授权目录并逐项授权；修改任务定义后需重新核对授权。'
            : '当前对话和面板操作会直接执行；定时提醒不会自动获得业务写入权限。',
        ),
      ),
    ),
    h(
      Section,
      { title: '已启用的操作', meta: `${policies.length} 项` },
      h(
        Card,
        null,
        h(
          'ul',
          { className: 'luo-setting-list' },
          policies.map((item) =>
            h(
              'li',
              { key: item.name },
              h('span', null, item.description),
              h(
                Pill,
                { tone: item.scheduled ? 'warn' : 'quiet' },
                item.scheduled ? '可逐任务授权' : '直接执行',
              ),
            ),
          ),
        ),
        h('p', { className: 'luo-fine' }, '模型配置由 DSH 的模型设置管理。'),
      ),
    ),
    h(Footer, { left: h(Stamp, { label: '读取于', value: clock(state.asOf) }) }),
  );
}
