import { Fragment, createElement as h, useEffect, useRef, useState } from 'react';
import { dataOf, errorOf, usePanelState } from './data.js';
import { clock, WATCHLIST_KIND, when } from './format.js';
import {
  Card,
  Empty,
  ErrorNote,
  Footer,
  Head,
  Pill,
  Refresh,
  Section,
  SkeletonLines,
  Stamp,
} from './primitives.js';
import {
  keepOperationCredential,
  operationIsUnsettled,
  requestResearch,
} from './research-transport.js';
import { StockDetail } from './stock.js';

const STAGES = {
  discovered: '新发现',
  watching: '观察中',
  researching: '研究中',
  confirmed: '已确认',
};
const PRIORITIES = { normal: '普通', important: '重点', urgent: '紧急' };
const SOURCES = { manual: '手动', strategy: '策略', ai: 'AI', portfolio: '持仓', import: '导入' };
const POLICIES = { manual: '手动维护', mixed: '手动与来源同步', synced: '来源同步' };
const ACTIONS = {
  create_watchlist: '新建关注列表',
  update_watchlist: '修改关注列表',
  archive_watchlist: '归档关注列表',
  add_watchlist_member: '添加股票',
  update_watchlist_member: '调整关注',
  archive_watchlist_member: '移除手动关注',
};
const OPERATION_STATES = {
  preparing: '正在准备',
  pending: '等待确认',
  executing: '正在执行',
  unknown: '结果待核对',
  succeeded: '已完成',
  cancelled: '已取消',
  failed: '执行失败',
};
const operationKey = 'luoome-watchlist-operation';
const operationRequest = (path, body) => requestResearch(`api/luoome/operations/${path}`, { body });
const readWatchlist = (watchlistId, signal) =>
  requestResearch('api/luoome/call', {
    body: { tool: 'get_watchlist', input: { watchlistId } },
    signal,
  });
const button = (label, onClick, disabled = false, props = {}) =>
  h(
    'button',
    {
      type: 'button',
      className: 'luo-btn',
      onClick,
      disabled,
      ...props,
    },
    label,
  );

function WatchlistEditor({ draft, busy, onSubmit, onClose }) {
  const [input, setInput] = useState(draft.input);
  const field = (label, key, options) =>
    h(
      'label',
      { className: 'luo-field' },
      label,
      h(
        options ? 'select' : 'input',
        {
          'aria-label': label,
          value: input[key] ?? '',
          disabled: busy,
          required: key !== 'description',
          maxLength: key === 'name' ? 80 : key === 'stockId' ? 24 : 1000,
          placeholder: key === 'stockId' ? '例如 600519.SH 或 600519' : undefined,
          onChange: (event) => setInput((current) => ({ ...current, [key]: event.target.value })),
        },
        options
          ? Object.entries(options).map(([value, text]) => h('option', { key: value, value }, text))
          : undefined,
      ),
    );
  const member = draft.tool.includes('_member');
  return h(
    Card,
    { title: ACTIONS[draft.tool], className: 'luo-watch-editor' },
    h(
      'form',
      {
        className: 'luo-form',
        onSubmit: (event) => {
          event.preventDefault();
          const trimmed = Object.fromEntries(
            Object.entries(input).map(([key, value]) => [
              key,
              typeof value === 'string' ? value.trim() : value,
            ]),
          );
          onSubmit({ ...draft, input: trimmed });
        },
      },
      member ? null : field('列表名称', 'name'),
      member ? null : field('关注说明', 'description'),
      draft.tool === 'add_watchlist_member' ? field('股票代码', 'stockId') : null,
      draft.tool === 'add_watchlist_member' ? field('关注理由', 'reason') : null,
      member
        ? h(
            'div',
            { className: 'luo-watch-fields' },
            field('研究阶段', 'stage', STAGES),
            field('优先级', 'priority', PRIORITIES),
          )
        : null,
      h(
        'div',
        { className: 'luo-actions' },
        h(
          'button',
          {
            type: 'submit',
            className: 'luo-btn is-primary',
            disabled:
              busy ||
              (!member && !input.name?.trim()) ||
              (draft.tool === 'add_watchlist_member' &&
                (!input.stockId?.trim() || !input.reason?.trim())),
          },
          busy ? '准备中…' : '保存修改',
        ),
        button('取消编辑', onClose, busy),
      ),
    ),
  );
}

function OperationPreview({ operation, items, busy, onAction, onClose }) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (operation.state !== 'pending') {
      setExpired(false);
      return;
    }
    const remaining = operation.expiresAt - Date.now();
    setExpired(remaining <= 0);
    const timer = setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [operation.state, operation.expiresAt]);
  const input = operation.input ?? {};
  const name = items.find(({ watchlist }) => watchlist.id === input.watchlistId)?.watchlist.name;
  const pending = operation.state === 'pending';
  return h(
    Card,
    {
      title: ACTIONS[operation.tool] ?? '关注操作',
      meta: expired ? '确认已过期' : OPERATION_STATES[operation.state],
      className: 'luo-watch-confirm',
    },
    h(
      'div',
      { className: 'luo-form', role: 'status' },
      name ? h('strong', null, name) : null,
      input.name ? h('p', null, `列表名称：${input.name}`) : null,
      input.description !== undefined
        ? h('p', null, `关注说明：${input.description || '清空'}`)
        : null,
      input.stockId ? h('p', null, `股票：${input.stockId}`) : null,
      input.reason ? h('p', null, `关注理由：${input.reason}`) : null,
      input.stage
        ? h('p', null, `研究阶段：${STAGES[input.stage]} · 优先级：${PRIORITIES[input.priority]}`)
        : null,
      input.enabled !== undefined
        ? h('p', null, `列表状态：${input.enabled ? '启用' : '停用'}`)
        : null,
      operation.tool === 'archive_watchlist_member'
        ? h(
            'p',
            { className: 'luo-fine' },
            '只结束手动关注；仍有策略、持仓或其他来源时，股票会保留在列表中。',
          )
        : null,
      operation.tool === 'archive_watchlist'
        ? h(
            'p',
            { className: 'luo-fine' },
            '归档会停用列表，保留成员和历史；被提醒计划引用的列表无法归档。',
          )
        : null,
      operation.result?.ok === false ? h(ErrorNote, { error: operation.result.error }) : null,
      pending
        ? h(
            'p',
            { className: 'luo-fine' },
            `核对以上内容后确认。有效期至 ${when(operation.expiresAt)}`,
          )
        : null,
      ['unknown', 'executing', 'preparing'].includes(operation.state)
        ? h('p', { className: 'luo-fine' }, '请先核对本次结果，避免重复提交。')
        : null,
      h(
        'div',
        { className: 'luo-actions' },
        pending && operation.confirmationToken && !expired
          ? button('确认修改', () => onAction('confirm'), busy, { className: 'luo-btn is-primary' })
          : null,
        pending && operation.confirmationToken
          ? button('取消操作', () => onAction('cancel'), busy)
          : null,
        button('核对结果', () => onAction('check'), busy),
        !operationIsUnsettled(operation) || (pending && (!operation.confirmationToken || expired))
          ? button(pending ? '重新准备' : '关闭回执', onClose, busy)
          : null,
      ),
    ),
  );
}

export function WatchlistsPanel({ onManageWatchlist, onAnalyzeStock }) {
  const state = usePanelState('watchlists');
  const catalog = dataOf(state.results, 'list_watchlists');
  const items = catalog?.items ?? [];
  const [selectedId, setSelectedId] = useState(null);
  const selected = items.find(({ watchlist }) => watchlist.id === selectedId) ?? items[0];
  const watchlistId = selected?.watchlist.id;
  const [detail, setDetail] = useState({ loading: false, data: null, error: null });
  const [draft, setDraft] = useState(null);
  const [operation, setOperation] = useState(() => {
    const id = sessionStorage.getItem(operationKey);
    return id ? { operationId: id, state: 'unknown' } : null;
  });
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [stock, setStock] = useState(null);
  const blocked = busy || operationIsUnsettled(operation);

  useEffect(() => {
    if (!watchlistId) {
      setDetail({ loading: false, data: null, error: null });
      return;
    }
    const controller = new AbortController();
    setDetail({ loading: true, data: null, error: null });
    readWatchlist(watchlistId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setDetail({ loading: false, data, error: null });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setDetail({ loading: false, data: null, error });
      });
    return () => controller.abort();
  }, [watchlistId, state.loadedAt]);

  const closeOperation = () => {
    setOperation(null);
    sessionStorage.removeItem(operationKey);
  };
  const accept = (next) => {
    setOperation((previous) => keepOperationCredential(previous, next));
    if (next.state === 'succeeded') {
      sessionStorage.removeItem(operationKey);
      setNotice('关注列表已更新');
      if (next.tool === 'create_watchlist') setSelectedId(next.result.data.watchlist.id);
      state.refresh();
    }
    if (['failed', 'cancelled'].includes(next.state)) sessionStorage.removeItem(operationKey);
  };
  const act = async (action, edit) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setNotice('');
    let current = operation;
    try {
      if (action === 'prepare') {
        if (operationIsUnsettled(operation)) return;
        current = {
          operationId: crypto.randomUUID(),
          state: 'preparing',
          tool: edit.tool,
          input: edit.input,
        };
        sessionStorage.setItem(operationKey, current.operationId);
        setOperation(current);
        const next = await operationRequest('prepare', {
          id: current.operationId,
          tool: edit.tool,
          input: edit.input,
        });
        accept(next);
        setDraft(null);
      } else if (action === 'check') {
        let next = await operationRequest(encodeURIComponent(current.operationId));
        if (['unknown', 'executing'].includes(next.state))
          next = await operationRequest(`${encodeURIComponent(current.operationId)}/reconcile`, {});
        accept(next);
      } else if (action === 'cancel') {
        await operationRequest(`${encodeURIComponent(current.operationId)}/cancel`, {
          token: current.confirmationToken,
        });
        accept(await operationRequest(encodeURIComponent(current.operationId)));
      } else {
        accept(
          await operationRequest(`${encodeURIComponent(current.operationId)}/confirm`, {
            token: current.confirmationToken,
          }),
        );
      }
    } catch (failure) {
      if (
        (action === 'prepare' &&
          ['invalid_input', 'permission_denied', 'not_found'].includes(failure.kind)) ||
        (action === 'check' && failure.kind === 'not_found')
      )
        closeOperation();
      else setOperation({ ...current, state: 'unknown', confirmationToken: null });
      setError(failure);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const manageWithAI = async () => {
    setError(null);
    setNotice('');
    setBusy(true);
    try {
      const request = onManageWatchlist(selected?.watchlist);
      const result = await request.completion;
      if (result?.ok === false) throw new Error('未能打开对话，请重试。');
      setNotice('管理需求已填入对话输入框，发送后继续。');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const edit = (tool, input) => {
    closeOperation();
    setError(null);
    setNotice('');
    setDraft({ tool, input });
  };
  const watchlist =
    detail.data && detail.data.watchlist.id === watchlistId ? detail.data.watchlist : null;
  const mutable = watchlist && watchlist.kind !== 'system';
  const members = watchlist ? detail.data.members : [];

  return h(
    Fragment,
    null,
    h(Head, {
      eyebrow: 'LUOOME / 关注',
      title: '关注',
      subtitle: '把值得持续研究的股票留在这里，手动整理，也可以与 AI 一起管理。',
      side: [
        h(Stamp, { key: 'time', label: '更新', value: clock(state.loadedAt) }),
        h(Refresh, { key: 'refresh', loading: state.loading, onClick: state.refresh }),
        button(
          '新建列表',
          () =>
            edit('create_watchlist', {
              name: '',
              description: '',
              kind: 'personal',
              membershipPolicy: 'mixed',
              enabled: true,
            }),
          blocked,
          { key: 'create', className: 'luo-btn is-primary' },
        ),
        button('交给 AI 管理', manageWithAI, blocked, { key: 'ai' }),
      ],
    }),
    state.panelError || errorOf(state.results, 'list_watchlists')
      ? h(ErrorNote, {
          label: '关注列表',
          error: state.panelError ?? errorOf(state.results, 'list_watchlists'),
        })
      : null,
    error ? h(ErrorNote, { error }) : null,
    notice ? h('p', { role: 'status', className: 'luo-fine' }, notice) : null,
    draft
      ? h(
          Section,
          null,
          h(WatchlistEditor, {
            key: `${draft.tool}:${draft.input.watchlistId ?? ''}:${draft.input.stockId ?? ''}`,
            draft,
            busy: blocked,
            onSubmit: (edit) => act('prepare', edit),
            onClose: () => setDraft(null),
          }),
        )
      : null,
    operation
      ? h(
          Section,
          null,
          h(OperationPreview, { operation, items, busy, onAction: act, onClose: closeOperation }),
        )
      : null,
    h(
      Section,
      { title: '关注列表', meta: catalog ? `${catalog.total} 个列表` : '读取中' },
      !catalog && state.loading
        ? h(SkeletonLines, { lines: 3 })
        : catalog && !items.length
          ? h(
              Card,
              null,
              h(Empty, {
                mark: '◇',
                title: '还没有关注列表',
                hint: '新建一个列表添加股票，或让 AI 帮你梳理关注方向。',
              }),
            )
          : h(
              'div',
              { className: 'luo-watch-layout' },
              h(
                'nav',
                { className: 'luo-watch-picker', 'aria-label': '选择关注列表' },
                items.map(({ watchlist, memberCount, sourceHealth }) =>
                  h(
                    'button',
                    {
                      key: watchlist.id,
                      type: 'button',
                      className: 'luo-watch-choice',
                      'aria-pressed': watchlist.id === watchlistId,
                      disabled: blocked,
                      onClick: () => {
                        setSelectedId(watchlist.id);
                        setDraft(null);
                        setStock(null);
                      },
                    },
                    h(
                      'span',
                      { className: 'luo-watch-choice-head' },
                      h('strong', null, watchlist.name),
                      h('span', { className: 'luo-mono' }, `${memberCount} 只`),
                    ),
                    h(
                      'span',
                      { className: 'luo-watch-meta' },
                      `${WATCHLIST_KIND[watchlist.kind]} · ${watchlist.enabled ? '启用' : '停用'}`,
                    ),
                    h(
                      'span',
                      { className: 'luo-watch-meta' },
                      sourceHealth.stale
                        ? `${sourceHealth.stale} 个来源待刷新`
                        : sourceHealth.active
                          ? '来源正常'
                          : '暂无关注来源',
                    ),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'luo-watch-content' },
                detail.loading ? h(Card, null, h(SkeletonLines, { lines: 4 })) : null,
                detail.error
                  ? h(
                      Card,
                      null,
                      h(ErrorNote, { error: detail.error }),
                      button('重新读取', state.refresh),
                    )
                  : null,
                watchlist
                  ? h(
                      Card,
                      {
                        title: watchlist.name,
                        meta: h(
                          Pill,
                          { tone: watchlist.enabled ? 'ok' : 'quiet' },
                          watchlist.enabled ? '启用' : '停用',
                        ),
                      },
                      h(
                        'p',
                        { className: 'luo-fine' },
                        watchlist.description || '为每只关注股票记录理由，持续跟进研究。',
                      ),
                      h(
                        'p',
                        { className: 'luo-watch-meta' },
                        `${WATCHLIST_KIND[watchlist.kind]} · ${POLICIES[watchlist.membershipPolicy]}`,
                      ),
                      h(
                        'div',
                        { className: 'luo-actions luo-watch-toolbar' },
                        watchlist.membershipPolicy !== 'synced' && mutable
                          ? button(
                              '添加股票',
                              () =>
                                edit('add_watchlist_member', {
                                  watchlistId,
                                  stockId: '',
                                  reason: '',
                                  stage: 'watching',
                                  priority: 'normal',
                                }),
                              blocked,
                            )
                          : null,
                        mutable
                          ? button(
                              '编辑列表',
                              () =>
                                edit('update_watchlist', {
                                  watchlistId,
                                  name: watchlist.name,
                                  description: watchlist.description ?? '',
                                }),
                              blocked,
                            )
                          : null,
                        mutable
                          ? button(
                              watchlist.enabled ? '停用列表' : '启用列表',
                              () =>
                                act('prepare', {
                                  tool: 'update_watchlist',
                                  input: { watchlistId, enabled: !watchlist.enabled },
                                }),
                              blocked,
                            )
                          : null,
                        mutable
                          ? button(
                              '归档列表',
                              () =>
                                act('prepare', {
                                  tool: 'archive_watchlist',
                                  input: { watchlistId },
                                }),
                              blocked,
                            )
                          : null,
                      ),
                      watchlist.membershipPolicy === 'synced'
                        ? h(
                            'p',
                            { className: 'luo-fine' },
                            '成员由来源同步；可让 AI 协助核对来源和管理方案。',
                          )
                        : null,
                      !members.length
                        ? h(Empty, {
                            title: '列表中还没有股票',
                            hint:
                              watchlist.membershipPolicy === 'synced'
                                ? '等待来源同步后，成员会显示在这里。'
                                : '点击「添加股票」，记录你的第一条关注理由。',
                          })
                        : h(
                            'div',
                            { className: 'luo-watch-members' },
                            members.map((row) =>
                              h(
                                'article',
                                { key: row.member.id, className: 'luo-watch-member' },
                                h(
                                  'div',
                                  { className: 'luo-watch-member-head' },
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'luo-stock-link',
                                      'aria-label': `查看${row.stockName ?? row.member.stockId}个股详情`,
                                      onClick: () => setStock(row),
                                    },
                                    h(
                                      'strong',
                                      { className: 'luo-stock-name' },
                                      row.stockName ?? '名称暂缺',
                                    ),
                                    h('span', { className: 'luo-stock-code' }, row.member.stockId),
                                  ),
                                  h(
                                    'div',
                                    { className: 'luo-actions' },
                                    h(Pill, null, STAGES[row.member.stage]),
                                    h(
                                      Pill,
                                      { tone: row.member.priority === 'urgent' ? 'warn' : 'quiet' },
                                      PRIORITIES[row.member.priority],
                                    ),
                                  ),
                                ),
                                h(
                                  'ul',
                                  { className: 'luo-watch-sources' },
                                  row.sources.map((source) =>
                                    h(
                                      'li',
                                      { key: source.id },
                                      h(
                                        'span',
                                        { className: 'luo-watch-source-kind' },
                                        SOURCES[source.kind],
                                      ),
                                      h('span', null, source.reason),
                                      source.status === 'stale'
                                        ? h(Pill, { tone: 'warn' }, '待刷新')
                                        : null,
                                    ),
                                  ),
                                ),
                                h(
                                  'div',
                                  { className: 'luo-actions' },
                                  mutable
                                    ? button(
                                        '调整阶段与优先级',
                                        () =>
                                          edit('update_watchlist_member', {
                                            watchlistId,
                                            stockId: row.member.stockId,
                                            stage: row.member.stage,
                                            priority: row.member.priority,
                                          }),
                                        blocked,
                                      )
                                    : null,
                                  mutable &&
                                    row.sources.some(
                                      (source) =>
                                        source.kind === 'manual' && source.status !== 'ended',
                                    )
                                    ? button(
                                        '移除手动关注',
                                        () =>
                                          act('prepare', {
                                            tool: 'archive_watchlist_member',
                                            input: { watchlistId, stockId: row.member.stockId },
                                          }),
                                        blocked,
                                      )
                                    : null,
                                ),
                              ),
                            ),
                          ),
                    )
                  : null,
              ),
            ),
    ),
    stock && watchlist
      ? h(StockDetail, {
          stock: { stockId: stock.member.stockId, stockName: stock.stockName ?? '名称暂缺' },
          sourceLabel: '关注来源',
          strategyName: watchlist.name,
          evidence: h(
            'ul',
            { className: 'luo-watch-sources' },
            stock.sources.map((source) =>
              h('li', { key: source.id }, `${SOURCES[source.kind]} · ${source.reason}`),
            ),
          ),
          onClose: () => setStock(null),
          onAnalyze: () =>
            onAnalyzeStock({
              watchlistId,
              watchlistName: watchlist.name,
              stockId: stock.member.stockId,
              stockName: stock.stockName,
            }),
        })
      : null,
    h(Footer, {
      left: '手动和 AI 管理使用同一份关注列表，修改前均需确认。',
      right: '关注仅供持续研究，不代表买入建议。',
    }),
  );
}
