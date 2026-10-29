import { createElement as h, useState } from 'react';
import { bigMoney, int, money, points, ratio, signedMoney, toneOf } from './format.js';
import { Empty, Kpi, Pill } from './primitives.js';

export function AccountSummary({ facts }) {
  return h(
    'div',
    { className: 'luo-grid is-kpi' },
    h(Kpi, { label: '账户总资产', value: money(facts.totalAssets) }),
    h(Kpi, { label: '账面现金', value: money(facts.cashBalance) }),
    h(Kpi, { label: '持仓市值', value: money(facts.stockMarketValue) }),
  );
}

export function MarketTable({ quotes, holdings, triggers, onStock }) {
  const [sort, setSort] = useState({ field: 'changePct', direction: -1 });
  const held = holdings !== undefined;
  const rows = held
    ? (holdings?.holdings ?? []).map((item) => ({
        ...item,
        stockId: item.holding.stockId,
        changePct: item.todayPnlPct,
      }))
    : (quotes?.items ?? []);
  const sortValue = (item, field) => (field === 'amount' ? item.quote?.amount : item[field]);
  const sorted = [...rows].sort((a, b) => {
    const left = sortValue(a, sort.field);
    const right = sortValue(b, sort.field);
    if (left === null || left === undefined) return right == null ? 0 : 1;
    if (right === null || right === undefined) return -1;
    return (left - right) * sort.direction;
  });
  const column = (field, label) =>
    h(
      'th',
      {
        key: field,
        scope: 'col',
        'aria-sort':
          sort.field === field ? (sort.direction === -1 ? 'descending' : 'ascending') : 'none',
      },
      h(
        'button',
        {
          type: 'button',
          className: 'luo-sort',
          'aria-label': `按${held ? '持仓' : '当前页'}${label}排序`,
          onClick: () => setSort({ field, direction: sort.field === field ? -sort.direction : -1 }),
        },
        label,
        sort.field === field ? (sort.direction === -1 ? ' ↓' : ' ↑') : ' ↕',
      ),
    );
  if (!rows.length)
    return h(Empty, {
      title: held ? '当前没有未平仓持仓' : '当前没有可展示的关注成员',
    });
  return h(
    'div',
    null,
    h(
      'div',
      {
        className: 'luo-table-wrap luo-market-scroll',
        tabIndex: 0,
        'aria-label': held ? '持仓行情表' : '自选行情表',
      },
      h(
        'table',
        { className: 'luo-table luo-market-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'col' }, '股票'),
            h('th', { scope: 'col' }, '最新价'),
            column('changePct', '涨跌幅'),
            ...(held
              ? [
                  h('th', { key: 'cost', scope: 'col' }, '成本 / 数量'),
                  h('th', { key: 'value', scope: 'col' }, '市值'),
                  column('pnl', '浮动盈亏'),
                  column('todayPnl', '今日盈亏'),
                ]
              : [
                  column('amount', '成交额'),
                  h('th', { key: 'turnover', scope: 'col' }, '换手率'),
                  h('th', { key: 'triggers', scope: 'col' }, '今日触发'),
                ]),
          ),
        ),
        h(
          'tbody',
          null,
          sorted.map((item) => {
            const quote = item.quote;
            const hit = triggers?.triggers?.find((trigger) => trigger.stockId === item.stockId);
            return h(
              'tr',
              { key: item.holding?.id ?? item.stockId, 'data-market-stock': item.stockId },
              h(
                'td',
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'luo-stock-link',
                    onClick: () =>
                      onStock({ stockId: item.stockId, stockName: item.stockName ?? item.stockId }),
                  },
                  h('span', { className: 'luo-stock-name' }, item.stockName ?? item.stockId),
                  h('span', { className: 'luo-stock-code' }, item.stockId),
                ),
              ),
              h('td', { className: `luo-${toneOf(item.changePct)}` }, money(quote?.close)),
              h('td', { className: `luo-${toneOf(item.changePct)}` }, ratio(item.changePct)),
              ...(held
                ? [
                    h(
                      'td',
                      { key: 'cost' },
                      money(item.holding.avgCost),
                      h('small', null, `${int(item.holding.quantity)} 股`),
                    ),
                    h('td', { key: 'value' }, money(item.marketValue)),
                    h(
                      'td',
                      { key: 'pnl', className: `luo-${toneOf(item.pnl)}` },
                      signedMoney(item.pnl),
                      h('small', null, ratio(item.pnlPct)),
                    ),
                    h(
                      'td',
                      { key: 'today', className: `luo-${toneOf(item.todayPnl)}` },
                      signedMoney(item.todayPnl),
                    ),
                  ]
                : [
                    h('td', { key: 'amount' }, bigMoney(quote?.amount)),
                    h('td', { key: 'turnover' }, points(quote?.turnoverRatePct, 2, false)),
                    h(
                      'td',
                      { key: 'triggers' },
                      hit
                        ? h('span', { title: hit.reason }, h(Pill, { tone: 'warn' }, '触发'))
                        : h('span', { className: 'luo-muted' }, '—'),
                    ),
                  ]),
            );
          }),
        ),
      ),
    ),
  );
}

export function SectorRanking({ data }) {
  return h(
    'div',
    null,
    data.items.length
      ? h(
          'ol',
          { className: 'luo-sector-list' },
          data.items.map((sector, index) =>
            h(
              'li',
              { key: sector.code },
              h('span', { className: 'luo-sector-rank' }, index + 1),
              h(
                'div',
                { className: 'luo-sector-main' },
                h('b', null, sector.name),
                h(
                  'small',
                  null,
                  `领涨 ${sector.leadingStockName || '—'} · 成交 ${bigMoney(sector.amount)}`,
                ),
              ),
              h(
                'strong',
                { className: `luo-mono luo-${toneOf(sector.changePct)}` },
                ratio(sector.changePct),
              ),
            ),
          ),
        )
      : h(Empty, { title: '暂无行业排行' }),
  );
}

export function NewsFeed({ data }) {
  return h(
    'div',
    null,
    data.items.length
      ? h(
          'ol',
          { className: 'luo-news-list' },
          data.items.map((item) =>
            h(
              'li',
              { key: item.id },
              /^https?:\/\//i.test(item.url)
                ? h(
                    'a',
                    { href: item.url, target: '_blank', rel: 'noopener noreferrer' },
                    item.title,
                  )
                : h('span', null, item.title),
              item.summary ? h('p', { className: 'luo-news-summary' }, item.summary) : null,
            ),
          ),
        )
      : h(Empty, { title: '暂无要闻' }),
  );
}
