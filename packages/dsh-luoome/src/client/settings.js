import { createElement as h, useEffect, useState } from 'react';
import { dataOf, errorOf, usePanelState } from './data.js';
import { clock, money, when } from './format.js';
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
  const needsKey = selected.includes('fuyao') && !data?.fuyao.configured;
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const next = await marketRequest({
        sources: selected,
        fuyao: { baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) },
      });
      setData(next);
      setBaseUrl(next.fuyao.baseUrl);
      setApiKey('');
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
                required: needsKey,
                placeholder: data.fuyao.configured ? '留空保留现有密钥' : '输入 API Key',
                disabled: busy,
                onChange: (event) => setApiKey(event.target.value),
              }),
            ),
            h('p', { className: 'luo-fine' }, '密钥仅保存在本机，保存后不回显。'),
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

export function SettingsPanel() {
  const state = usePanelState('settings');
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
