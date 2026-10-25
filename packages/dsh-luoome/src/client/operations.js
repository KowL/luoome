import { createElement as h, useEffect, useState } from 'react';

const storageKey = 'luoome:last-operation';
const states = {
  pending: '等待确认',
  executing: '正在执行',
  succeeded: '已完成',
  cancelled: '已取消',
  unknown: '结果待核对',
  failed: '执行失败',
};
const request = async (path, body) => {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  if (response.status === 401 || response.status === 403)
    throw new Error('当前账户或确认权限不可用，请重新登录并查询操作状态。');
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('未收到完整响应，请先查询操作状态，避免重复提交。');
  }
  if (!response.ok || result.ok === false)
    throw new Error(result.error?.message ?? result.error?.kind ?? `请求失败 (${response.status})`);
  return result.data ?? result;
};

function OperationsPanel() {
  const [profile, setProfile] = useState(null);
  const [tool, setTool] = useState('save_decision_review');
  const [input, setInput] = useState('{}');
  const [id, setId] = useState(() => sessionStorage.getItem(storageKey) ?? '');
  const [operation, setOperation] = useState(null);
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (operation?.state !== 'pending') {
      setExpired(false);
      return;
    }
    const remaining = operation.expiresAt - Date.now();
    setExpired(remaining <= 0);
    const timer = setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [operation]);
  useEffect(() => {
    let active = true;
    request('api/luoome/profile')
      .then((value) => {
        if (active) setProfile(value);
      })
      .catch(() => {
        if (active) setError('无法读取账户，请检查连接后重试。');
      });
    return () => {
      active = false;
    };
  }, []);
  const perform = async (work) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  const accept = (value) => {
    setOperation(value);
    setId(value.operationId);
    sessionStorage.setItem(storageKey, value.operationId);
  };
  const prepare = () =>
    perform(async () => {
      const nextId = crypto.randomUUID();
      let parsed;
      try {
        parsed = JSON.parse(input);
      } catch {
        throw new Error('操作参数不是有效的 JSON，请修正后重试。');
      }
      setToken(null);
      setOperation(null);
      setId(nextId);
      sessionStorage.setItem(storageKey, nextId);
      const value = await request('api/luoome/operations/prepare', {
        id: nextId,
        tool,
        input: parsed,
      });
      // The one-time credential stays in component memory, never URL/storage/logs.
      setToken(value.confirmationToken ?? null);
      accept(value);
    });
  const settle = (action) =>
    perform(async () => {
      const value = await request(
        `api/luoome/operations/${encodeURIComponent(operation.operationId)}/${action}`,
        action === 'reconcile' ? {} : { token },
      );
      accept(
        action === 'cancel'
          ? await request(`api/luoome/operations/${encodeURIComponent(operation.operationId)}`)
          : value,
      );
      if (value.state !== 'pending') setToken(null);
    });
  const query = () =>
    perform(async () => {
      const value = await request(`api/luoome/operations/${encodeURIComponent(id.trim())}`);
      if (operation?.operationId !== value.operationId) setToken(null);
      accept(value);
    });
  return h(
    'section',
    { className: 'luoome-operations', 'aria-labelledby': 'luoome-operations-title' },
    h(
      'header',
      null,
      h('p', { className: 'luoome-eyebrow' }, 'LUOOME / 操作确认'),
      h('h1', { id: 'luoome-operations-title' }, '每次写入，先核对。'),
      h('p', null, profile ? `当前账户 ${profile.accountId}` : '正在读取账户…'),
      h(
        'span',
        { className: 'luoome-status' },
        profile?.automationsEnabled ? '此验证环境允许调度' : '自动任务未启用',
      ),
    ),
    h(
      'div',
      { className: 'luoome-columns' },
      h(
        'form',
        {
          onSubmit: (event) => {
            event.preventDefault();
            prepare();
          },
        },
        h('h2', null, '准备操作'),
        h('p', null, '提交后仅冻结参数。核对右侧内容，再逐次确认写入。'),
        h(
          'label',
          null,
          '操作',
          h(
            'select',
            { value: tool, disabled: busy, onChange: (event) => setTool(event.target.value) },
            ...(profile?.policies ?? [{ name: 'save_decision_review' }]).map((policy) =>
              h('option', { key: policy.name, value: policy.name }, policy.name),
            ),
            h('option', { value: 'configure_plugin_automation' }, 'configure_plugin_automation'),
          ),
        ),
        h(
          'label',
          null,
          '操作参数（JSON）',
          h('textarea', {
            value: input,
            onChange: (event) => setInput(event.target.value),
            spellCheck: false,
            rows: 12,
            disabled: busy,
            required: true,
          }),
        ),
        h(
          'button',
          {
            type: 'submit',
            disabled: busy || !profile || (operation?.state === 'pending' && !expired),
          },
          busy ? '处理中…' : '准备并核对',
        ),
      ),
      h(
        'div',
        { className: 'luoome-receipt', 'aria-live': 'polite' },
        h('h2', null, '冻结内容与回执'),
        operation
          ? h(
              'div',
              null,
              h(
                'p',
                { className: 'luoome-state' },
                expired ? '确认已过期' : (states[operation.state] ?? operation.state),
              ),
              h(
                'dl',
                null,
                h('dt', null, '操作编号'),
                h('dd', null, operation.operationId),
                h('dt', null, '账户 / 操作'),
                h('dd', null, `${operation.accountId} / ${operation.tool}`),
                h('dt', null, '有效期'),
                h('dd', null, new Date(operation.expiresAt).toLocaleString()),
              ),
              h('pre', { tabIndex: 0 }, JSON.stringify(operation.input, null, 2)),
              expired && h('p', null, '确认已过期，可重新准备。'),
              operation.state === 'pending' &&
                !expired &&
                (token
                  ? h(
                      'div',
                      { className: 'luoome-actions' },
                      h(
                        'button',
                        { type: 'button', disabled: busy, onClick: () => settle('confirm') },
                        '确认本次写入',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'secondary',
                          disabled: busy,
                          onClick: () => settle('cancel'),
                        },
                        '取消本次操作',
                      ),
                    )
                  : h(
                      'p',
                      null,
                      '本页没有原确认凭据，无法继续确认。可回到原页面取消，或等此操作过期后重新准备。',
                    )),
              ['executing', 'unknown'].includes(operation.state) &&
                h(
                  'button',
                  { type: 'button', disabled: busy, onClick: () => settle('reconcile') },
                  '核对业务回执',
                ),
              operation.result &&
                h(
                  'details',
                  null,
                  h('summary', null, '查看完整业务回执'),
                  h('pre', { tabIndex: 0 }, JSON.stringify(operation.result, null, 2)),
                ),
            )
          : h('p', null, '尚未准备操作。这里将显示服务器冻结的参数。'),
      ),
    ),
    h(
      'form',
      {
        className: 'luoome-query',
        onSubmit: (event) => {
          event.preventDefault();
          query();
        },
      },
      h(
        'label',
        null,
        '查询已有操作',
        h('input', {
          value: id,
          onChange: (event) => setId(event.target.value),
          required: true,
          placeholder: '操作编号',
        }),
      ),
      h(
        'button',
        { type: 'submit', className: 'secondary', disabled: busy || !id.trim() },
        '查询状态',
      ),
    ),
    error && h('p', { role: 'alert', className: 'luoome-error' }, error),
    h(
      'p',
      { className: 'luoome-footnote' },
      '仅处理已开放的复盘和授权操作。投资建议不等于交易指令。模型发起的操作仍需在对话中的 DSH 审批卡逐次确认。',
    ),
  );
}

export const inject = ['slots'];
export function apply(ctx) {
  const style = document.createElement('style');
  style.textContent = `.luoome-operations{max-width:1120px;margin:auto;padding:42px 32px 64px;color:var(--dsw-alias-label-primary);font:14px/1.65 Georgia,"Songti SC",serif;overflow:auto;height:100%;box-sizing:border-box}.luoome-eyebrow{font:11px/1.5 monospace;letter-spacing:.16em;color:#7b857f}.luoome-operations h1{font-size:32px;letter-spacing:-.04em;margin:8px 0}.luoome-operations h2{font-size:18px;margin:0 0 16px}.luoome-status{display:inline-block;border:1px solid #9caaa0;padding:3px 10px;border-radius:3px;font-size:12px}.luoome-columns{display:grid;grid-template-columns:minmax(240px,1fr) minmax(280px,1.15fr);gap:36px;margin-top:32px}.luoome-operations label{display:flex;flex-direction:column;gap:7px;margin:16px 0}.luoome-operations input,.luoome-operations select,.luoome-operations textarea{box-sizing:border-box;width:100%;padding:10px;border:1px solid #8b948e;border-radius:4px;color:inherit;background:transparent;font:12px/1.6 monospace}.luoome-operations textarea{resize:vertical}.luoome-operations button{border:1px solid #355b4a;border-radius:4px;padding:9px 16px;background:#355b4a;color:#fff;cursor:pointer;font:inherit}.luoome-operations button.secondary{background:transparent;color:inherit;border-color:#9caaa0}.luoome-operations button:disabled{opacity:.5;cursor:default}.luoome-operations :focus-visible{outline:2px solid #6d9a84;outline-offset:3px}.luoome-receipt{border-left:2px solid #8a9f90;padding-left:26px;min-width:0}.luoome-state{font-weight:bold}.luoome-operations dl{font-size:12px}.luoome-operations dt{color:#7b857f;margin-top:10px}.luoome-operations dd{margin:0;overflow-wrap:anywhere}.luoome-operations pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace;background:#82948712;border:1px solid #82948733;padding:14px;border-radius:4px;max-height:340px;overflow:auto}.luoome-actions{display:flex;gap:10px;flex-wrap:wrap}.luoome-query{border-top:1px solid #82948744;margin-top:32px;padding-top:16px;display:flex;align-items:end;gap:12px}.luoome-query label{flex:1;margin:0;min-width:0}.luoome-footnote{color:#7b857f;font-size:12px;margin-top:28px}.luoome-error{color:#b43f39;border-left:2px solid currentColor;padding-left:12px}@media(max-width:720px){.luoome-operations{padding:24px 18px}.luoome-columns{grid-template-columns:1fr;gap:24px}.luoome-receipt{padding-left:18px}.luoome-operations h1{font-size:26px}}`;
  document.head.appendChild(style);
  ctx.effect(() => () => style.remove());
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: 'luoome-operations' }, OperationsPanel),
  );
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: 'luoome-operations', order: 21, label: () => '操作确认' },
      () => h('span', { 'aria-hidden': true }, '✓'),
    ),
  );
}
