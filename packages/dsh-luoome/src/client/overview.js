import { Fragment, createElement as h, useCallback, useState } from 'react';

import { dataOf, marketObservationOf, useAutoRefresh, useOverviewSection } from './data.js';
import {
  bigMoney,
  int,
  MARKET_SESSION,
  money,
  points,
  ratio,
  signedMoney,
  toneOf,
} from './format.js';
import { AccountSummary, MarketTable, NewsFeed, SectorRanking } from './overview-market.js';
import {
  Card,
  cx,
  Empty,
  ErrorNote,
  Footer,
  Head,
  Kpi,
  PanelHealthBadge,
  Pill,
  Skeleton,
  SkeletonLines,
  Stat,
} from './primitives.js';
import { holdingPriceView, reminderGapsView } from './projection.js';
import { StockDetail } from './stock.js';

const SESSION_TONE = {
  'pre-open': 'warn',
  trading: 'up',
  'midday-break': 'quiet',
  closed: 'quiet',
  'non-trading-day': 'quiet',
};

const IndexCard = ({ quote }) => {
  const tone = toneOf(quote.changePct);
  return h(
    'div',
    { className: 'luo-index', style: { '--lu-tone': `var(--lu-${tone})` } },
    h(
      'div',
      { className: 'luo-index-top' },
      h('span', { className: 'luo-index-name' }, quote.name),
      h('span', { className: 'luo-index-code' }, quote.code),
    ),
    h('div', { className: 'luo-index-price' }, money(quote.close)),
    h(
      'div',
      { className: 'luo-index-delta' },
      h('span', { className: `luo-${tone}` }, signedMoney(quote.change)),
      h('span', { className: `luo-${tone}` }, points(quote.changePct)),
    ),
  );
};

const IndexStrip = ({ quotes, loading, error }) => {
  const values = quotes?.indices ?? [];
  if (values.length > 0) {
    return h(
      'div',
      { className: 'luo-grid is-index' },
      values.map((quote) => h(IndexCard, { key: quote.code, quote })),
    );
  }
  if (loading) {
    return h(
      'div',
      { className: 'luo-grid is-index' },
      Array.from({ length: 4 }, (_, index) =>
        h(
          'div',
          { key: index, className: 'luo-index' },
          h(Skeleton, { variant: 'line' }),
          h(Skeleton, { variant: 'value' }),
        ),
      ),
    );
  }
  return h(
    Card,
    { title: '核心指数' },
    error
      ? h(ErrorNote, { label: '指数', error })
      : h(Empty, {
          title: quotes?.unsupported ? '当前行情源不支持指数' : '暂未返回指数行情',
        }),
  );
};

const BreadthCard = ({ snapshot, marketObservation, loading, error }) => {
  const breadth = snapshot?.breadth?.value;
  const limitUp = snapshot?.limitUp?.value;
  const themes = snapshot?.themes?.value;

  if (!breadth && !limitUp) {
    return h(
      Card,
      { title: '市场温度' },
      loading ? h(SkeletonLines, { lines: 4 }) : h(ErrorNote, { label: '市场温度', error }),
    );
  }

  const total = breadth ? breadth.advancing + breadth.declining + breadth.unchanged : 0;
  const width = (value) => (total > 0 ? `${(value / total) * 100}%` : '0%');
  const leaders = limitUp?.leaders ?? [];

  return h(
    Card,
    { title: '市场温度' },
    // 三档标注（S6）：`label` 由服务端用 core 的 `marketObservationLabel` 算好，
    // client **不做任何日期比较**，只渲染字符串 + 配色。
    marketObservation === null
      ? null
      : h(
          'div',
          {
            className: cx('luo-stamp', `luo-${marketObservation.tone}`),
            'data-market-observation': marketObservation.scope ?? 'unknown',
          },
          marketObservation.label,
        ),
    breadth
      ? h(
          'div',
          null,
          h(
            'div',
            { className: 'luo-breadth', role: 'img', 'aria-label': '涨跌家数分布' },
            h('span', { style: { width: width(breadth.advancing), background: 'var(--lu-up)' } }),
            h('span', {
              style: { width: width(breadth.unchanged), background: 'var(--lu-line-strong)' },
            }),
            h('span', { style: { width: width(breadth.declining), background: 'var(--lu-down)' } }),
          ),
          h(
            'div',
            { className: 'luo-breadth-legend' },
            h('span', null, '上涨 ', h('b', { className: 'luo-up' }, int(breadth.advancing))),
            h('span', null, '平盘 ', h('b', null, int(breadth.unchanged))),
            h('span', null, '下跌 ', h('b', { className: 'luo-down' }, int(breadth.declining))),
            h('span', null, '样本 ', h('b', null, int(breadth.total))),
          ),
        )
      : null,
    h(
      'div',
      { className: 'luo-substats' },
      h(Stat, { k: '涨停封板', v: int(limitUp?.sealedCount), tone: 'up' }),
      h(Stat, { k: '炸板', v: int(limitUp?.brokenCount), tone: 'down' }),
      h(Stat, { k: '炸板率', v: ratio(limitUp?.brokenRate, 1, false) }),
      h(Stat, { k: '最高连板', v: limitUp ? `${int(limitUp.maxLadderLevel)} 板` : '—' }),
      h(Stat, { k: '涨停封单', v: bigMoney(limitUp?.totalSealAmount) }),
    ),
    limitUp?.boardDistribution && Object.keys(limitUp.boardDistribution).length > 0
      ? h(
          'div',
          { className: 'luo-subblock' },
          h('div', { className: 'luo-subblock-t' }, '连板分布'),
          h(
            'div',
            { className: 'luo-ladder' },
            Object.entries(limitUp.boardDistribution)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([level, count]) =>
                h('span', { key: level }, `${level} 板`, h('b', null, `${count} 只`)),
              ),
          ),
        )
      : null,
    leaders.length > 0
      ? h(
          'div',
          { className: 'luo-subblock' },
          h('div', { className: 'luo-subblock-t' }, '连板龙头'),
          h(
            'div',
            { className: 'luo-breadth-legend' },
            leaders
              .slice(0, 5)
              .map((leader) =>
                h(
                  'span',
                  { key: leader.stockId },
                  h('b', null, leader.name),
                  ` ${leader.ladderLevel} 板`,
                  leader.sealAmount ? ` · ${bigMoney(leader.sealAmount)}` : '',
                ),
              ),
          ),
        )
      : null,
    themes && (themes.industries?.length > 0 || themes.concepts?.length > 0)
      ? h(
          'div',
          { className: 'luo-subblock' },
          h('div', { className: 'luo-subblock-t' }, '主线板块'),
          h(
            'div',
            { className: 'luo-breadth-legend', style: { gap: '8px' } },
            [...(themes.industries ?? []).slice(0, 5), ...(themes.concepts ?? []).slice(0, 3)].map(
              (theme) =>
                h(Pill, { key: theme.name, tone: 'quiet' }, `${theme.name} ${theme.count}`),
            ),
          ),
        )
      : null,
  );
};

export const HoldingsTable = ({ holdings, loading, error, actions }) => {
  if (!holdings) {
    return h(
      Card,
      { title: '持仓', meta: loading ? '读取中' : null },
      loading ? h(SkeletonLines, { lines: 5 }) : h(ErrorNote, { label: '持仓', error }),
    );
  }
  const rows = holdings.holdings ?? [];
  if (rows.length === 0) {
    return h(
      Card,
      { title: '持仓', meta: '0 条' },
      h(Empty, {
        mark: '◇',
        title: '当前没有未平仓持仓',
        hint: '买入并记账后，这里会显示市值与盈亏。',
      }),
    );
  }
  return h(
    Card,
    {
      title: '持仓',
      meta: `${rows.length} 只 · 市值 ${money(holdings.totalValue)}`,
    },
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
            h('th', null, '标的'),
            h('th', null, '数量'),
            h('th', null, '成本'),
            h('th', null, '现价'),
            h('th', null, '市值'),
            h('th', null, '浮动盈亏'),
            h('th', null, '今日'),
            actions ? h('th', null, '记账') : null,
          ),
        ),
        h(
          'tbody',
          null,
          rows.map((item) => {
            const holding = item.holding ?? {};
            // 缺价判据只看服务端 priceStatus（REQ-M3-09）：缺价时渲染原因，绝不渲染 0。
            const priceView = holdingPriceView(item);
            const pnlTone = priceView.canShowNumbers ? toneOf(item.pnl) : 'flat';
            const todayTone = toneOf(item.todayPnl);
            return h(
              'tr',
              { key: holding.id ?? holding.stockId },
              h(
                'td',
                null,
                h('span', { className: 'luo-stock-name' }, item.stockName),
                h('span', { className: 'luo-stock-code' }, holding.stockId),
              ),
              h('td', null, int(holding.quantity)),
              h('td', null, money(holding.avgCost)),
              h(
                'td',
                null,
                priceView.canShowNumbers ? money(item.currentPrice) : priceView.unavailableText,
              ),
              h(
                'td',
                null,
                priceView.canShowNumbers ? money(item.marketValue) : priceView.unavailableText,
              ),
              h(
                'td',
                { className: `luo-${pnlTone}` },
                h(
                  'span',
                  { className: 'luo-strong' },
                  priceView.canShowNumbers ? signedMoney(item.pnl) : priceView.unavailableText,
                ),
                h(
                  'span',
                  { className: 'luo-fine', style: { display: 'block' } },
                  priceView.canShowNumbers ? ratio(item.pnlPct) : priceView.unavailableText,
                ),
              ),
              h(
                'td',
                { className: `luo-${todayTone}` },
                signedMoney(item.todayPnl),
                h(
                  'span',
                  { className: 'luo-fine', style: { display: 'block' } },
                  ratio(item.todayPnlPct),
                ),
              ),
              actions ? h('td', null, actions(item)) : null,
            );
          }),
        ),
      ),
    ),
  );
};

const Region = ({ name, title, state, children, className = '' }) =>
  h(
    'section',
    {
      className: `luo-region ${className}`,
      'data-overview-section': name,
      'aria-busy': state.loading,
      'aria-label': title,
    },
    h(
      'header',
      { className: 'luo-region-head' },
      h('h2', null, title),
      h(
        'div',
        { className: 'luo-region-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'luo-btn',
            onClick: state.refresh,
            'aria-label': `刷新${title}`,
          },
          state.loading ? '加载中' : state.error ? '重试' : '刷新',
        ),
      ),
    ),
    state.error
      ? h(
          'div',
          { className: 'luo-region-error' },
          h(ErrorNote, { error: { message: state.loadedAt ? '刷新失败' : '加载失败' } }),
        )
      : null,
    state.loadedAt ? children : state.loading ? h(SkeletonLines, { lines: 3 }) : null,
  );

export function OverviewPanel({ onAnalyzeStock }) {
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState('watchlist');
  const [stock, setStock] = useState(null);
  const indices = useOverviewSection('indices');
  const sentiment = useOverviewSection('sentiment');
  const account = useOverviewSection('account');
  const holdings = useOverviewSection('holdings');
  const watchlist = useOverviewSection('watchlist', page);
  const triggers = useOverviewSection('triggers');
  const sectors = useOverviewSection('sectors');
  const news = useOverviewSection('news');
  const refreshers = [
    indices.refresh,
    sentiment.refresh,
    account.refresh,
    holdings.refresh,
    watchlist.refresh,
    triggers.refresh,
    sectors.refresh,
    news.refresh,
  ];
  const refresh = useCallback(() => {
    for (const read of refreshers) read();
  }, refreshers);
  const session = indices.session ?? account.session;
  const marketSession = session?.marketSession;
  const nextSessionStart = session?.nextSessionStart ?? null;
  useAutoRefresh({ marketSession, nextSessionStart, refresh });
  const held = dataOf(holdings.results, 'list_holdings');
  const facts = dataOf(account.results, 'get_account_facts')?.facts;
  const triggerData = dataOf(triggers.results, 'list_watch_triggers');
  const pagination = watchlist.watchlistPage;
  const pageCount = pagination ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize)) : 1;
  const selectedState = tab === 'holdings' ? holdings : watchlist;
  const selectedTitle = tab === 'holdings' ? '持仓行情' : '自选行情';
  const region = (name, title, state, content, className) =>
    h(Region, { name, title, state, className }, content);
  return h(
    Fragment,
    null,
    // REQ-M3-09：面板顶层「数据健康」角标（只渲染服务端 health，不在这里判断可用性）。
    h(PanelHealthBadge, { key: 'health', health: indices.health ?? null }),
    h(Head, {
      eyebrow: 'LUOOME / MARKET',
      title: '看盘',
      subtitle: '行情 · 账户 · 关注动态',
      side: [
        marketSession
          ? h(
              Pill,
              { key: 'session', tone: SESSION_TONE[marketSession] ?? 'quiet', dot: true },
              MARKET_SESSION[marketSession] ?? marketSession,
            )
          : null,
        h(
          'button',
          { key: 'refresh', type: 'button', className: 'luo-btn', onClick: refresh },
          '刷新全部',
        ),
      ],
    }),
    region(
      'indices',
      '核心指数',
      indices,
      h(IndexStrip, { quotes: dataOf(indices.results, 'fetch_index_quotes') }),
      'luo-region-strip',
    ),
    region(
      'account',
      '账户概览',
      account,
      facts ? h(AccountSummary, { facts }) : null,
      'luo-region-strip',
    ),
    h(
      'div',
      { className: 'luo-terminal-grid' },
      h(
        'main',
        { className: 'luo-terminal-main' },
        h(
          'div',
          { className: 'luo-market-tabs', role: 'tablist', 'aria-label': '行情范围' },
          ['watchlist', 'holdings'].map((name) =>
            h(
              'button',
              {
                key: name,
                type: 'button',
                role: 'tab',
                'aria-selected': tab === name,
                'aria-controls': 'luo-market-content',
                className: tab === name ? 'is-active' : '',
                onClick: () => setTab(name),
              },
              name === 'watchlist' ? '自选' : '持仓',
            ),
          ),
        ),
        h(
          'div',
          { id: 'luo-market-content', role: 'tabpanel', 'aria-label': selectedTitle },
          region(
            tab,
            selectedTitle,
            selectedState,
            h(
              'div',
              null,
              tab === 'holdings' && held
                ? h(
                    'div',
                    { className: 'luo-grid is-kpi luo-holding-stats' },
                    h(Kpi, {
                      label: '浮动盈亏',
                      value: signedMoney(held.totalPnL),
                      tone: toneOf(held.totalPnL),
                      sub: ratio(held.totalPnLPct),
                    }),
                    h(Kpi, {
                      label: '今日盈亏',
                      value: signedMoney(held.totalTodayPnl),
                      tone: toneOf(held.totalTodayPnl),
                      sub: ratio(held.totalTodayPnlPct),
                    }),
                  )
                : null,
              // 提醒要素缺口（REQ-M3-09 §5）：两个数分开显示，未投递用 warning，不适用用 factual。
              ...(() => {
                const gaps = reminderGapsView(triggerData?.summary);
                if (gaps === null) return [];
                return [
                  ...(gaps.missingText === null
                    ? []
                    : [
                        h(
                          'p',
                          { key: 'gap-missing', className: 'luo-fine luo-warn-text' },
                          gaps.missingText,
                        ),
                      ]),
                  ...(gaps.notApplicableText === null
                    ? []
                    : [
                        h(
                          'p',
                          { key: 'gap-na', className: 'luo-fine luo-muted' },
                          gaps.notApplicableText,
                        ),
                      ]),
                ];
              })(),
              h(MarketTable, {
                key: tab,
                quotes: dataOf(watchlist.results, 'batch_quote'),
                holdings: tab === 'holdings' ? held : undefined,
                triggers: triggerData,
                onStock: (selected) => setStock({ ...selected, sourceLabel: selectedTitle }),
              }),
              tab === 'watchlist' && pagination
                ? h(
                    'div',
                    null,
                    pagination.incomplete
                      ? h('p', { className: 'luo-fine luo-warn-text' }, '部分列表加载失败')
                      : null,
                    h(
                      'div',
                      { className: 'luo-pagination' },
                      h('span', null, `共 ${pagination.total} 只 · 第 ${page} / ${pageCount} 页`),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'luo-btn',
                          disabled: page === 1,
                          onClick: () => setPage((current) => Math.max(1, current - 1)),
                        },
                        '上一页',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'luo-btn',
                          disabled: page >= pageCount,
                          onClick: () => setPage((current) => current + 1),
                        },
                        '下一页',
                      ),
                    ),
                  )
                : null,
            ),
          ),
        ),
        region(
          'news',
          '市场要闻',
          news,
          dataOf(news.results, 'fetch_news')
            ? h(NewsFeed, { data: dataOf(news.results, 'fetch_news') })
            : null,
        ),
      ),
      h(
        'aside',
        { className: 'luo-terminal-side', 'aria-label': '市场动态' },
        region(
          'sentiment',
          '市场温度',
          sentiment,
          h(BreadthCard, {
            snapshot: dataOf(sentiment.results, 'get_ashare_sentiment')?.snapshot,
            marketObservation: marketObservationOf(sentiment),
          }),
        ),
        region(
          'sectors',
          '行业涨幅榜 · 前五',
          sectors,
          dataOf(sectors.results, 'fetch_sector_quotes')
            ? h(SectorRanking, { data: dataOf(sectors.results, 'fetch_sector_quotes') })
            : null,
        ),
      ),
    ),
    h(Footer, {
      left: '建议不等于交易，信心度不是概率。',
    }),
    stock
      ? h(StockDetail, {
          key: stock.stockId,
          stock,
          sourceLabel: stock.sourceLabel,
          onClose: () => setStock(null),
          onAnalyze: () => onAnalyzeStock({ ...stock, sourceKind: 'overview' }),
        })
      : null,
  );
}
