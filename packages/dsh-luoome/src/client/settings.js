import { createElement as h, useState } from 'react';
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
        setMessage('结果尚未确认，请核对结果后再操作。');
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
          busy ? '处理中' : '预览修改',
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
    null,
    h(Head, {
      eyebrow: 'Workspace settings',
      title: '账户与设置',
      subtitle: '当前账户、数据健康与已启用的操作范围',
      side: h(Refresh, { loading: state.loading, onClick: state.refresh }),
    }),
    state.panelError ? h(ErrorNote, { label: '设置', error: state.panelError }) : null,
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
          '自动任务由 DSH 的「自动化任务」管理时间和会话。每项批处理还需确认对应账户、工具、参数和有效期。',
        ),
        h(
          'p',
          { className: 'luo-fine' },
          config?.automationsEnabled
            ? '可在对话中读取任务授权目录并逐项授权；修改任务定义后需重新核对授权。'
            : '当前可以对话和逐次确认写入；定时提醒不会自动获得业务写入权限。',
        ),
      ),
    ),
    h(
      Section,
      { title: '已启用的确认操作', meta: `${policies.length} 项` },
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
                item.scheduled ? '可逐任务授权' : '每次确认',
              ),
            ),
          ),
        ),
        h(
          'p',
          { className: 'luo-fine' },
          '模型与供应商配置沿用 DSH 设置。此页不保存或回显模型密钥。',
        ),
      ),
    ),
    h(Footer, { left: h(Stamp, { label: '读取于', value: clock(state.asOf) }) }),
  );
}
