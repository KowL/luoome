import { Fragment, createElement as h, useRef, useState } from 'react';
import { dataOf, errorOf, usePanelState } from './data.js';
import { clock, int, money, ratio, signedMoney, toneOf, when } from './format.js';
import { HoldingsTable } from './overview.js';
import {
  Card,
  Empty,
  ErrorNote,
  Footer,
  Head,
  Kpi,
  PanelHealthBadge,
  Pill,
  Refresh,
  Section,
  Stamp,
} from './primitives.js';
import {
  keepOperationCredential,
  operationIsUnsettled,
  requestResearch,
} from './research-transport.js';

const Table = ({ columns, rows }) =>
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
          columns.map((label) => h('th', { key: label, scope: 'col' }, label)),
        ),
      ),
      h('tbody', null, rows),
    ),
  );

const operationRequest = (path, body) => requestResearch(`api/luoome/operations/${path}`, { body });
const OPERATION_KEY = 'luoome-positions-operation';
const WRITE_TITLES = {
  add_trade: '登记成交',
  close_holding: '平仓',
  create_portfolio_cash_flow: '现金流水',
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
const CASH_KINDS = [
  ['deposit', '入金'],
  ['withdrawal', '出金'],
  ['dividend', '分红'],
  ['fee', '费用'],
];
const CASH_KIND_LABEL = Object.fromEntries(CASH_KINDS);
const SIDES = [
  ['buy', '买入'],
  ['sell', '卖出'],
];
const SIDE_LABEL = { buy: '买入', sell: '卖出' };
const STOCK_ID = /^[A-Z0-9]{1,12}\.(SH|SZ|BJ|HK|US)$/;

const pad = (value) => String(value).padStart(2, '0');
/** datetime-local 需要本地时间字符串；服务端最终收到的是 ISO。 */
const localStamp = (date = new Date()) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
const toIso = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const toNumber = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const button = (label, onClick, disabled = false, props = {}) =>
  h('button', { type: 'button', className: 'luo-btn', onClick, disabled, ...props }, label);

const field = (
  label,
  { value, onChange, type = 'text', step, min, placeholder, disabled, required = true },
) =>
  h(
    'label',
    { className: 'luo-field' },
    label,
    h('input', {
      'aria-label': label,
      type,
      value,
      step,
      min,
      placeholder,
      disabled,
      required,
      onChange,
    }),
  );

function TradeForm({ draft, busy, onSubmit, onClose }) {
  const [input, setInput] = useState(draft.input);
  const bind = (key) => (event) => {
    const { value } = event.target;
    setInput((current) => ({ ...current, [key]: value }));
  };
  const stockId = String(input.stockId ?? '')
    .trim()
    .toUpperCase();
  const quantity = toNumber(input.quantity);
  const price = toNumber(input.price);
  const fee = toNumber(input.fee === '' ? 0 : input.fee);
  const executedAt = toIso(input.executedAt);
  const valid =
    STOCK_ID.test(stockId) &&
    quantity !== null &&
    Number.isInteger(quantity) &&
    quantity > 0 &&
    price !== null &&
    price > 0 &&
    fee !== null &&
    fee >= 0 &&
    executedAt !== null;
  return h(
    Card,
    { title: WRITE_TITLES.add_trade, meta: '人工记账 · 不是下单' },
    h(
      'form',
      {
        className: 'luo-form',
        onSubmit: (event) => {
          event.preventDefault();
          if (!valid) return;
          onSubmit({
            tool: 'add_trade',
            input: {
              stockId,
              ...(input.stockName ? { stockName: String(input.stockName) } : {}),
              side: input.side,
              quantity,
              price,
              fee,
              executedAt,
            },
          });
        },
      },
      h(
        'label',
        { className: 'luo-field' },
        '方向',
        h(
          'select',
          { 'aria-label': '方向', value: input.side, disabled: busy, onChange: bind('side') },
          SIDES.map(([value, text]) => h('option', { key: value, value }, text)),
        ),
      ),
      field('股票代码', {
        value: input.stockId,
        onChange: bind('stockId'),
        placeholder: '例如 600519.SH',
        disabled: busy,
      }),
      field('数量（股）', {
        value: input.quantity,
        onChange: bind('quantity'),
        type: 'number',
        min: 1,
        step: 1,
        disabled: busy,
      }),
      field('成交价', {
        value: input.price,
        onChange: bind('price'),
        type: 'number',
        min: 0.001,
        step: 0.001,
        disabled: busy,
      }),
      field('费用', {
        value: input.fee,
        onChange: bind('fee'),
        type: 'number',
        min: 0,
        step: 0.01,
        disabled: busy,
      }),
      field('成交时间', {
        value: input.executedAt,
        onChange: bind('executedAt'),
        type: 'datetime-local',
        disabled: busy,
      }),
      h(
        'div',
        { className: 'luo-actions' },
        h(
          'button',
          { type: 'submit', className: 'luo-btn', disabled: busy || !valid },
          busy ? '准备中…' : '核对并记账',
        ),
        button('取消', onClose, busy),
        h(
          'span',
          { className: 'luo-fine' },
          '卖出会减少持仓与可卖数量；数量归零时持仓自动标记平仓。',
        ),
      ),
    ),
  );
}

function CashFlowForm({ draft, busy, onSubmit, onClose }) {
  const [input, setInput] = useState(draft.input);
  const bind = (key) => (event) => {
    const { value } = event.target;
    setInput((current) => ({ ...current, [key]: value }));
  };
  const amount = toNumber(input.amount);
  const occurredAt = toIso(input.occurredAt);
  const valid = amount !== null && amount > 0 && occurredAt !== null;
  return h(
    Card,
    {
      title: WRITE_TITLES.create_portfolio_cash_flow,
      meta: '只记账户资金事实',
    },
    h(
      'form',
      {
        className: 'luo-form',
        onSubmit: (event) => {
          event.preventDefault();
          if (!valid) return;
          onSubmit({
            tool: 'create_portfolio_cash_flow',
            input: {
              occurredAt,
              kind: input.kind,
              amount,
              ...(input.currency ? { currency: String(input.currency) } : {}),
              ...(input.note?.trim() ? { note: String(input.note).trim() } : {}),
            },
          });
        },
      },
      h(
        'label',
        { className: 'luo-field' },
        '类型',
        h(
          'select',
          { 'aria-label': '类型', value: input.kind, disabled: busy, onChange: bind('kind') },
          CASH_KINDS.map(([value, text]) => h('option', { key: value, value }, text)),
        ),
      ),
      field('金额', {
        value: input.amount,
        onChange: bind('amount'),
        type: 'number',
        min: 0.01,
        step: 0.01,
        disabled: busy,
      }),
      field('发生时间', {
        value: input.occurredAt,
        onChange: bind('occurredAt'),
        type: 'datetime-local',
        disabled: busy,
      }),
      field('备注（可选）', {
        value: input.note ?? '',
        onChange: bind('note'),
        disabled: busy,
        required: false,
      }),
      h(
        'div',
        { className: 'luo-actions' },
        h(
          'button',
          { type: 'submit', className: 'luo-btn', disabled: busy || !valid },
          busy ? '准备中…' : '核对并记账',
        ),
        button('取消', onClose, busy),
        h('span', { className: 'luo-fine' }, '金额一律为正数，方向由类型决定。'),
      ),
    ),
  );
}

const summaryOf = (operation) => {
  const input = operation.input ?? {};
  if (operation.tool === 'add_trade')
    return [
      `股票：${input.stockId}`,
      `方向：${SIDE_LABEL[input.side] ?? input.side} · 数量 ${int(input.quantity)} · 价格 ${money(input.price)} · 费用 ${money(input.fee)}`,
      `成交时间：${when(input.executedAt)}`,
    ];
  if (operation.tool === 'close_holding')
    return [`持仓：${input.holdingId}`, '软关闭：保留历史成交与绩效，不删除持仓行'];
  return [
    `类型：${CASH_KIND_LABEL[input.kind] ?? input.kind} · 金额 ${money(input.amount)} ${input.currency ?? ''}`,
    `发生时间：${when(input.occurredAt)}`,
    ...(input.note ? [`备注：${input.note}`] : []),
  ];
};

function OperationCard({ operation, busy, onAction, onClose }) {
  const pending = operation.state === 'pending';
  const lines = operation.input === undefined ? [] : summaryOf(operation);
  return h(
    Card,
    {
      title: WRITE_TITLES[operation.tool] ?? '记账操作',
      meta: OPERATION_STATES[operation.state] ?? operation.state,
    },
    h(
      'div',
      { className: 'luo-form', role: 'status' },
      lines.length
        ? lines.map((line) => h('p', { key: line }, line))
        : h('p', { className: 'luo-fine' }, '冻结参数未知：先核对结果，或等此操作过期后重新记账。'),
      operation.result?.ok === false
        ? h(ErrorNote, { label: '写入失败', error: operation.result.error })
        : null,
      operation.result?.ok === true
        ? h('p', { className: 'luo-fine' }, '业务回执已保存；重复提交只读回同一份回执。')
        : null,
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
        pending && operation.confirmationToken
          ? button('确认写入', () => onAction('confirm'), busy, { className: 'luo-btn is-primary' })
          : null,
        pending && operation.confirmationToken
          ? button('取消操作', () => onAction('cancel'), busy)
          : null,
        button('核对结果', () => onAction('check'), busy),
        !operationIsUnsettled(operation) ? button('关闭回执', onClose, busy) : null,
      ),
    ),
  );
}

const emptyDraft = (tool, stock = {}) =>
  tool === 'add_trade'
    ? {
        tool,
        input: {
          stockId: stock.stockId ?? '',
          ...(stock.stockName ? { stockName: stock.stockName } : {}),
          side: stock.side ?? 'buy',
          quantity: '',
          price: '',
          fee: '0',
          executedAt: localStamp(),
        },
      }
    : {
        tool,
        input: { kind: 'deposit', amount: '', occurredAt: localStamp(), note: '' },
      };

const useLedgerWrites = (refresh, currency) => {
  const [draft, setDraft] = useState(null);
  // 打开表单时自增：React key 换一次就会丢弃上一份草稿状态，避免同名标的重开时残留旧数字。
  const [openSeq, setOpenSeq] = useState(0);
  const [operation, setOperation] = useState(() => {
    const id = sessionStorage.getItem(OPERATION_KEY);
    return id ? { operationId: id, state: 'unknown' } : null;
  });
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');

  const accept = (next) => {
    setOperation((previous) => keepOperationCredential(previous, next));
    if (next.state === 'succeeded') {
      sessionStorage.removeItem(OPERATION_KEY);
      setNotice('账户事实已更新');
      refresh();
    }
    if (['failed', 'cancelled'].includes(next.state)) sessionStorage.removeItem(OPERATION_KEY);
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
        // 幂等键：同一 operationId 的重试只会读回同一份回执，不会第二次写库。
        current = {
          operationId: crypto.randomUUID(),
          state: 'preparing',
          tool: edit.tool,
          input: edit.input,
        };
        sessionStorage.setItem(OPERATION_KEY, current.operationId);
        setOperation(current);
        accept(
          await operationRequest('prepare', {
            id: current.operationId,
            tool: edit.tool,
            input: edit.input,
          }),
        );
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
      // prepare 被业务拒绝 = 没有留下任何 operation：丢掉编号，让用户改草稿重来；
      // 其它失败（网络/超时）可能已经落库，保留编号等核对，不能假装没发生。
      if (
        action === 'prepare' &&
        ['invalid_input', 'permission_denied', 'not_found'].includes(failure.kind)
      )
        closeOperation();
      else setOperation({ ...current, state: 'unknown', confirmationToken: null });
      setError(failure);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const blocked = busy || operationIsUnsettled(operation);
  const closeOperation = () => {
    setOperation(null);
    sessionStorage.removeItem(OPERATION_KEY);
  };
  return {
    draft,
    setDraft,
    operation,
    busy,
    blocked,
    error,
    notice,
    act,
    closeOperation,
    open: (tool, stock) => {
      closeOperation();
      setError(null);
      setNotice('');
      setOpenSeq((value) => value + 1);
      setDraft(emptyDraft(tool, stock));
    },
    openSeq,
    currency,
  };
};

export function PositionsPanel() {
  const state = usePanelState('positions');
  const { results, loading, health, refresh } = state;
  const account = dataOf(results, 'get_account')?.account;
  const holdings = dataOf(results, 'list_holdings');
  const trades = dataOf(results, 'list_trades');
  const performance = dataOf(results, 'list_account_performance_snapshots');
  const latest = performance?.snapshots?.[0];
  const writes = useLedgerWrites(refresh, account?.currency);
  const rows = holdings?.holdings ?? [];
  const rowActions = (item) =>
    h(
      'div',
      { className: 'luo-actions' },
      button(
        '平仓',
        () =>
          writes.act('prepare', {
            tool: 'close_holding',
            input: { holdingId: item.holding.id },
          }),
        writes.blocked,
      ),
      button(
        '减仓',
        () =>
          writes.open('add_trade', {
            stockId: item.holding.stockId,
            stockName: item.stockName,
            side: 'sell',
          }),
        writes.blocked,
      ),
    );
  return h(
    Fragment,
    null,
    // REQ-M3-09：面板顶层「数据健康」角标（只渲染服务端 health，不在这里判断可用性）。
    h(PanelHealthBadge, { key: 'health', health }),
    h(Head, {
      eyebrow: 'Portfolio ledger',
      title: '持仓与账本',
      subtitle: account
        ? `${account.name} · ${account.currency} · ${account.id}`
        : '当前账户的持仓、已登记成交与绩效快照',
      side: h(Refresh, { loading, onClick: refresh }),
    }),
    state.panelError ? h(ErrorNote, { label: '持仓页', error: state.panelError }) : null,
    h(
      Section,
      null,
      h(
        'div',
        { className: 'luo-grid is-kpi' },
        h(Kpi, { label: '持仓市值', value: money(holdings?.totalValue) }),
        h(Kpi, { label: '账面现金', value: money(account?.cashBalance) }),
        h(Kpi, {
          label: '持仓浮动盈亏',
          value: signedMoney(holdings?.totalPnL),
          sub: ratio(holdings?.totalPnLPct),
          tone: toneOf(holdings?.totalPnL),
        }),
        h(Kpi, {
          label: '今日持仓盈亏',
          value: signedMoney(holdings?.totalTodayPnl),
          sub: '缺少昨收时保持未知',
          tone: toneOf(holdings?.totalTodayPnl),
        }),
      ),
    ),
    h(
      Section,
      {
        title: '记账与账户维护',
        meta: '写入先冻结参数，再由你确认；同一操作编号重复提交不重复写库',
      },
      h(
        Card,
        null,
        h(
          'div',
          { className: 'luo-actions' },
          button('登记成交', () => writes.open('add_trade'), writes.blocked, {
            className: 'luo-btn is-primary',
          }),
          button('现金流水', () => writes.open('create_portfolio_cash_flow'), writes.blocked),
        ),
        h(
          'p',
          { className: 'luo-fine' },
          '登记成交是人工记账，不等于下单；平仓与减仓分别走 close_holding 与卖出成交。',
        ),
      ),
      writes.draft?.tool === 'add_trade'
        ? h(TradeForm, {
            key: `trade-${writes.openSeq}`,
            draft: writes.draft,
            busy: writes.busy,
            onSubmit: (edit) => writes.act('prepare', edit),
            onClose: () => writes.setDraft(null),
          })
        : null,
      writes.draft?.tool === 'create_portfolio_cash_flow'
        ? h(CashFlowForm, {
            key: `cash-${writes.openSeq}`,
            draft: { ...writes.draft, input: { ...writes.draft.input, currency: writes.currency } },
            busy: writes.busy,
            onSubmit: (edit) => writes.act('prepare', edit),
            onClose: () => writes.setDraft(null),
          })
        : null,
      writes.operation
        ? h(OperationCard, {
            operation: writes.operation,
            busy: writes.busy,
            onAction: writes.act,
            onClose: writes.closeOperation,
          })
        : null,
      writes.notice ? h('p', { role: 'status', className: 'luo-fine' }, writes.notice) : null,
      writes.error ? h(ErrorNote, { label: '记账操作', error: writes.error }) : null,
    ),
    h(
      Section,
      { title: '当前持仓', meta: '估值口径由账户工具提供' },
      h(HoldingsTable, {
        holdings,
        loading,
        error: errorOf(results, 'list_holdings'),
        actions: rows.length ? rowActions : null,
      }),
    ),
    h(
      Section,
      {
        title: '最近登记的成交',
        meta: trades ? `展示 ${int(trades.trades?.length)} / ${int(trades.total)} 条` : null,
      },
      h(
        Card,
        null,
        errorOf(results, 'list_trades')
          ? h(ErrorNote, { label: '成交记录', error: errorOf(results, 'list_trades') })
          : null,
        trades?.trades?.length
          ? h(Table, {
              columns: ['标的 / 时间', '方向', '数量', '成交价', '费用', '来源'],
              rows: trades.trades.map((trade) =>
                h(
                  'tr',
                  { key: trade.id },
                  h(
                    'td',
                    null,
                    h('strong', null, trade.stockId),
                    h('div', { className: 'luo-fine' }, when(trade.executedAt)),
                  ),
                  h(
                    'td',
                    null,
                    h(
                      Pill,
                      { tone: trade.side === 'buy' ? 'up' : 'down' },
                      trade.side === 'buy' ? '买入' : '卖出',
                    ),
                  ),
                  h('td', null, int(trade.quantity)),
                  h('td', null, money(trade.price)),
                  h('td', null, money(trade.fee)),
                  h('td', null, trade.source === 'manual' ? '人工登记' : trade.source),
                ),
              ),
            })
          : !loading && !errorOf(results, 'list_trades')
            ? h(Empty, { title: '暂无已登记成交', hint: '持仓录入与实际成交是两类事实。' })
            : null,
        trades?.nextCursor
          ? h(
              'p',
              { className: 'luo-fine' },
              '此页展示最近 50 条；更早的成交可在对话中按时间查询。',
            )
          : null,
      ),
    ),
    h(
      Section,
      {
        title: '绩效快照',
        meta: latest?.dataAsOf ? `事实截止 ${when(latest.dataAsOf)}` : '仅展示已保存的计算结果',
      },
      h(
        Card,
        null,
        errorOf(results, 'list_account_performance_snapshots')
          ? h(ErrorNote, {
              label: '绩效',
              error: errorOf(results, 'list_account_performance_snapshots'),
            })
          : null,
        performance?.snapshots?.length
          ? h(Table, {
              columns: ['统计区间', '时间加权收益', '最大回撤', '盈亏', '完整性'],
              rows: performance.snapshots.map((item) =>
                h(
                  'tr',
                  { key: item.id },
                  h('td', null, `${when(item.from)} — ${when(item.to)}`),
                  h('td', { className: `luo-${toneOf(item.twrPct)}` }, ratio(item.twrPct)),
                  h('td', null, ratio(item.maxDrawdownPct)),
                  h('td', null, signedMoney(item.totalPnl)),
                  h(
                    'td',
                    null,
                    item.completeness === 'complete'
                      ? '完整'
                      : item.completeness === 'partial'
                        ? '部分缺失'
                        : '不可用',
                  ),
                ),
              ),
            })
          : !loading && !errorOf(results, 'list_account_performance_snapshots')
            ? h(Empty, {
                title: '尚无绩效快照',
                hint: '快照由绩效批处理生成；本页刷新只读取事实。',
              })
            : null,
        latest?.warnings?.length
          ? h('p', { className: 'luo-fine' }, latest.warnings.join('；'))
          : null,
      ),
    ),
    h(Footer, {
      left: h(Stamp, { label: '读取于', value: clock(state.asOf) }),
      right: '持仓浮动盈亏与账户绩效口径不同，缺失数据保持未知。',
    }),
  );
}
