import { createElement as h, useState } from 'react';
import { bigMoney, int, money, points, ratio, signedMoney, toneOf, when } from './format.js';
import { Empty, Kpi, Pill, Stat } from './primitives.js';
import { holdingPriceView } from './projection.js';

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
            // 缺价判据只看服务端 priceStatus（REQ-M3-09）：缺价时渲染原因，绝不渲染 0。
            const priceView = holdingPriceView(item);
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
                    h(
                      'td',
                      { key: 'value' },
                      priceView.canShowNumbers
                        ? money(item.marketValue)
                        : priceView.unavailableText,
                    ),
                    h(
                      'td',
                      {
                        key: 'pnl',
                        className: `luo-${priceView.canShowNumbers ? toneOf(item.pnl) : 'flat'}`,
                      },
                      priceView.canShowNumbers ? signedMoney(item.pnl) : priceView.unavailableText,
                      h(
                        'small',
                        null,
                        priceView.canShowNumbers ? ratio(item.pnlPct) : priceView.unavailableText,
                      ),
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

export function SectorRanking({ data, onStock, holdings, watchlist }) {
  const [selected, setSelected] = useState(null);
  if (!data.items.length) return h(Empty, { title: '暂无行业排行' });
  const sector = data.items.find((item) => item.code === selected);
  const leaderCode = sector?.leadingStockCode;
  const leader =
    typeof leaderCode === 'string' && /^\d{6}\.(SH|SZ|BJ)$/.test(leaderCode)
      ? leaderCode
      : typeof leaderCode === 'string' && /^[036]\d{5}$/.test(leaderCode)
        ? `${leaderCode}.${leaderCode.startsWith('6') ? 'SH' : 'SZ'}`
        : null;
  const held = leader && holdings?.holdings?.some((item) => item.holding.stockId === leader);
  const watched = leader && watchlist?.items?.some((item) => item.stockId === leader);
  return h(
    'div',
    null,
    h(
      'ol',
      { className: 'luo-sector-list' },
      data.items.map((item, index) =>
        h(
          'li',
          { key: item.code },
          h(
            'button',
            {
              type: 'button',
              className: 'luo-sector-select',
              'aria-expanded': item.code === selected,
              'aria-controls': 'luo-sector-detail',
              onClick: () => setSelected(item.code === selected ? null : item.code),
            },
            h('span', { className: 'luo-sector-rank' }, index + 1),
            h(
              'span',
              { className: 'luo-sector-main' },
              h('b', null, item.name),
              h(
                'small',
                null,
                `领涨 ${item.leadingStockName || '—'} · 成交 ${bigMoney(item.amount)}`,
              ),
            ),
            h(
              'strong',
              { className: `luo-mono luo-${toneOf(item.changePct)}` },
              ratio(item.changePct),
            ),
          ),
        ),
      ),
    ),
    sector
      ? h(
          'section',
          {
            id: 'luo-sector-detail',
            className: 'luo-sector-detail',
            'aria-label': `${sector.name}行业详情`,
          },
          h('h3', null, sector.name, h('small', null, sector.code)),
          h(
            'div',
            { className: 'luo-stats' },
            h(Stat, { k: '指数点位', v: money(sector.price) }),
            h(Stat, { k: '成交额', v: bigMoney(sector.amount) }),
            h(Stat, { k: '上涨家数', v: int(sector.upCount) }),
            h(Stat, { k: '下跌家数', v: int(sector.downCount) }),
          ),
          leader || sector.leadingStockName
            ? h(
                'div',
                { className: 'luo-sector-leader' },
                h('span', { className: 'luo-fine' }, '领涨股'),
                leader && onStock
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'luo-stock-link',
                        onClick: () =>
                          onStock({
                            stockId: leader,
                            stockName: sector.leadingStockName || leader,
                            sourceLabel: `${sector.name} · 行业领涨股`,
                          }),
                      },
                      sector.leadingStockName || leader,
                      h('small', null, leader),
                    )
                  : h('strong', null, sector.leadingStockName || leader),
                h(
                  'span',
                  { className: `luo-mono luo-${toneOf(sector.leadingStockChangePct)}` },
                  ratio(sector.leadingStockChangePct),
                ),
                held ? h(Pill, { tone: 'quiet' }, '已持仓') : null,
                watched ? h(Pill, { tone: 'quiet' }, '当前页关注') : null,
              )
            : h('p', { className: 'luo-fine' }, '上游未提供领涨股。'),
          h(
            'p',
            { className: 'luo-fine' },
            `来源 ${data.source} · 读取于 ${when(data.asOf)}。仅展示当前行业截面，不代表完整成分或历史归属。`,
          ),
          data.warnings.length
            ? h(
                'p',
                { className: 'luo-fine luo-warn-text' },
                `数据提示：${data.warnings.join('、')}`,
              )
            : null,
        )
      : h('p', { className: 'luo-fine' }, '点选行业，查看涨跌家数与领涨股。'),
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
