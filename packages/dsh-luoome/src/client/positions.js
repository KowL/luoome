import { Fragment, createElement as h } from 'react';
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
  Pill,
  Refresh,
  Section,
  Stamp,
} from './primitives.js';

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

export function PositionsPanel() {
  const state = usePanelState('positions');
  const { results, loading, refresh } = state;
  const account = dataOf(results, 'get_account')?.account;
  const holdings = dataOf(results, 'list_holdings');
  const trades = dataOf(results, 'list_trades');
  const performance = dataOf(results, 'list_account_performance_snapshots');
  const latest = performance?.snapshots?.[0];
  return h(
    Fragment,
    null,
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
      { title: '当前持仓', meta: '估值口径由账户工具提供' },
      h(HoldingsTable, { holdings, loading, error: errorOf(results, 'list_holdings') }),
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
