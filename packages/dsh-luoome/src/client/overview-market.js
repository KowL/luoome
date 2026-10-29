import { createElement as h, useState } from 'react';
import { bigMoney, int, money, points, ratio, signedMoney, toneOf, when } from './format.js';
import { Empty, Kpi, Pill } from './primitives.js';

export function AccountSummary({ facts }) {
  return h(
    'div',
    null,
    h(
      'div',
      { className: 'luo-grid is-kpi' },
      h(Kpi, { label: '账户总资产', value: money(facts.totalAssets), sub: '现金 + 股票市值' }),
      h(Kpi, { label: '账面现金', value: money(facts.cashBalance), sub: '来自资金账本' }),
      h(Kpi, { label: '持仓市值', value: money(facts.stockMarketValue), sub: '合格行情估值' }),
    ),
    facts.reasons?.length
      ? h('p', { className: 'luo-fine luo-warn-text' }, facts.reasons.join('；'))
      : null,
    facts.notes?.length ? h('p', { className: 'luo-fine' }, facts.notes.join('；')) : null,
  );
}

export function MarketTable({ quotes, holdings, triggers, triggerState, onStock }) {
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
          onClick: () => setSort({ field, direction: sort.field === field ? -sort.direction : -1 }),
        },
        label,
        sort.field === field ? (sort.direction === -1 ? ' ↓' : ' ↑') : ' ↕',
      ),
    );
  if (!rows.length)
    return h(Empty, {
      title: held ? '当前没有未平仓持仓' : '当前没有可展示的关注成员',
      hint: held ? '持仓记账后可查看市值与盈亏。' : '自选汇总已启用关注列表中当前账户可见的成员。',
    });
  return h(
    'div',
    null,
    h(
      'div',
      { className: 'luo-market-caption' },
      h('span', null, `${rows.length} 只 · ${held ? '持仓排序' : '当前页排序'} · 点击股票查看详情`),
      held ? null : h('span', null, '今日触发：最近 8 条中的命中'),
    ),
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
            h('th', { scope: 'col' }, '股票 / 行情时间'),
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
            const stale = item.freshness === 'stale' || item.retrieval === 'local-fallback';
            const stamp = quote
              ? `${quote.source} · ${quote.timestampSource === 'upstream' ? '行情' : '抓取'} ${when(quote.observedAt)}`
              : (item.reason ?? '行情缺失');
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
                    title: stamp,
                  },
                  h('span', { className: 'luo-stock-name' }, item.stockName ?? item.stockId),
                  h('span', { className: 'luo-stock-code' }, item.stockId),
                ),
                h('span', { className: 'luo-quote-stamp', title: stamp }, stamp),
                stale
                  ? h(
                      Pill,
                      { tone: 'warn' },
                      item.retrieval === 'local-fallback' ? '保留快照' : '已过时',
                    )
                  : null,
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
                        ? h(
                            'span',
                            { title: hit.reason },
                            h(Pill, { tone: 'warn' }, '触发'),
                            triggerState.error ? h('small', null, '上次数据') : null,
                          )
                        : h(
                            'span',
                            {
                              className: 'luo-muted',
                              title: triggerState.error
                                ? '触发数据读取失败'
                                : triggerState.loading
                                  ? '触发数据读取中'
                                  : '最近 8 条未见命中，不代表全天无触发',
                            },
                            '—',
                          ),
                    ),
                  ]),
            );
          }),
        ),
      ),
    ),
    held
      ? h(
          'p',
          { className: 'luo-fine' },
          '市值与盈亏沿用持仓工具的估值口径；缺失行情的最新价保持未知。',
        )
      : null,
  );
}

const Warnings = ({ data }) =>
  data.warnings?.length
    ? h('p', { className: 'luo-fine luo-warn-text' }, data.warnings.join('；'))
    : null;

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
    h('p', { className: 'luo-fine' }, `按涨跌幅降序 · ${data.source} · ${when(data.asOf)}`),
    h(Warnings, { data }),
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
              h(
                'div',
                { className: 'luo-news-meta' },
                h('time', { dateTime: item.publishedAt }, when(item.publishedAt)),
                h('span', null, item.source),
              ),
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
    h(Warnings, { data }),
  );
}
