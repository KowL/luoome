import { createElement as h, useCallback, useState } from 'react';

import { IDLE_REFRESH_INTERVAL_MS, TRADING_REFRESH_INTERVAL_MS } from './auto-refresh.js';
import { dataOf, useAutoRefresh, useOverviewSection } from './data.js';
import {
  bigMoney,
  clock,
  DECISION,
  DELIVERY,
  HORIZON,
  int,
  MARKET_SESSION,
  money,
  PRIORITY,
  points,
  RULE_KIND,
  ratio,
  relative,
  SUBJECT_KIND,
  signedMoney,
  subjectTitle,
  toneOf,
  WATCH_STATE,
  WATCHLIST_KIND,
  when,
} from './format.js';
import { AccountSummary, MarketTable, NewsFeed, SectorRanking } from './overview-market.js';
import {
  Card,
  Empty,
  ErrorNote,
  Footer,
  Head,
  Kpi,
  Meter,
  Panel,
  Pill,
  Section,
  Skeleton,
  SkeletonLines,
  Stat,
} from './primitives.js';
import { StockDetail } from './stock.js';

const SESSION_TONE = {
  'pre-open': 'warn',
  trading: 'up',
  'midday-break': 'quiet',
  closed: 'quiet',
  'non-trading-day': 'quiet',
};

const AUTO_REFRESH_PREFIX = {
  'pre-open': '盘前',
  'midday-break': '午间休市',
  closed: '交易时段外',
  'non-trading-day': '非交易日',
};

/** 头部刷新节奏提示：一眼能看出当前是否在自动刷新、下一次什么时候刷新。 */
const autoRefreshHint = (marketSession, nextSessionStart) => {
  const tradingText = `盘中自动刷新 · 每 ${TRADING_REFRESH_INTERVAL_MS / 1000} 秒`;
  const idleText = `每 ${IDLE_REFRESH_INTERVAL_MS / 60_000} 分钟检查`;
  if (marketSession === 'trading') return { tone: 'accent', text: tradingText };
  if (marketSession === undefined || marketSession === null) {
    return { tone: 'quiet', text: `时段未知 · ${idleText}` };
  }
  const prefix = AUTO_REFRESH_PREFIX[marketSession] ?? '交易时段外';
  if (nextSessionStart) {
    return { tone: 'quiet', text: `${prefix} · ${when(nextSessionStart)} 后自动刷新` };
  }
  return { tone: 'quiet', text: `${prefix} · ${idleText}` };
};

const DimensionHint = ({ dimension }) => {
  if (!dimension || dimension.status === 'complete') return null;
  const warnings = dimension.warnings ?? [];
  return h(
    'p',
    { className: 'luo-fine', style: { marginTop: '10px' } },
    dimension.status === 'partial' ? '数据不完整' : '数据不可用',
    warnings.length > 0 ? ` · ${warnings.slice(0, 2).join('；')}` : '',
  );
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
    h('div', { className: 'luo-index-src' }, `${quote.source} · ${when(quote.ts)}`),
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
          hint: '可稍后刷新，数据缺失不会按零展示。',
        }),
  );
};

const BreadthCard = ({ snapshot, loading, error }) => {
  const breadth = snapshot?.breadth?.value;
  const limitUp = snapshot?.limitUp?.value;
  const themes = snapshot?.themes?.value;

  if (!breadth && !limitUp) {
    return h(
      Card,
      { title: '市场温度', meta: snapshot?.date ?? null },
      loading ? h(SkeletonLines, { lines: 4 }) : h(ErrorNote, { label: '市场温度', error }),
      h(DimensionHint, { dimension: snapshot?.breadth }),
    );
  }

  const total = breadth ? breadth.advancing + breadth.declining + breadth.unchanged : 0;
  const width = (value) => (total > 0 ? `${(value / total) * 100}%` : '0%');
  const leaders = limitUp?.leaders ?? [];

  return h(
    Card,
    { title: '市场温度', meta: snapshot?.date ?? null },
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
    h(DimensionHint, { dimension: snapshot?.limitUp }),
  );
};

export const HoldingsTable = ({ holdings, loading, error }) => {
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
          ),
        ),
        h(
          'tbody',
          null,
          rows.map((item) => {
            const holding = item.holding ?? {};
            const pnlTone = toneOf(item.pnl);
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
              h('td', null, money(item.currentPrice)),
              h('td', null, money(item.marketValue)),
              h(
                'td',
                { className: `luo-${pnlTone}` },
                h('span', { className: 'luo-strong' }, signedMoney(item.pnl)),
                h(
                  'span',
                  { className: 'luo-fine', style: { display: 'block' } },
                  ratio(item.pnlPct),
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
            );
          }),
        ),
      ),
    ),
  );
};

const TriggersCard = ({ triggers, loading, error }) => {
  if (!triggers) {
    return h(
      Card,
      { title: '今日触发', meta: loading ? '读取中' : null },
      loading ? h(SkeletonLines, { lines: 4 }) : h(ErrorNote, { label: '今日触发', error }),
    );
  }
  const rows = triggers.triggers ?? [];
  if (rows.length === 0) {
    return h(
      Card,
      { title: '今日触发', meta: '0 条' },
      h(Empty, {
        mark: '○',
        title: '今天没有触发',
        hint: 'AlertPlan 命中后会在这里留下证据与送达状态。',
      }),
    );
  }
  return h(
    Card,
    { title: '今日触发', meta: `${triggers.total} 条` },
    h(
      'div',
      { className: 'luo-list' },
      rows.slice(0, 8).map((trigger) => {
        const priority = PRIORITY[trigger.priority] ?? PRIORITY.normal;
        return h(
          'div',
          { key: trigger.id, className: 'luo-row' },
          h('i', { className: `luo-pri is-${priority.tone}`, 'aria-hidden': true }),
          h(
            'div',
            { className: 'luo-row-main' },
            h(
              'div',
              { className: 'luo-row-title' },
              h('b', null, trigger.stockName ?? trigger.stockId),
              h(Pill, { tone: priority.tone === 'urgent' ? 'warn' : 'quiet' }, priority.label),
              h(
                'span',
                { className: 'luo-muted' },
                RULE_KIND[trigger.ruleKind] ?? trigger.ruleKind,
              ),
            ),
            h('div', { className: 'luo-row-sub' }, trigger.reason),
          ),
          h(
            'div',
            { className: 'luo-row-side' },
            h('div', null, relative(trigger.createdAt)),
            h('div', null, DELIVERY[trigger.deliveryStatus] ?? trigger.deliveryStatus),
          ),
        );
      }),
    ),
  );
};

const WatchlistsCard = ({ watchlists, loading, error }) => {
  if (!watchlists) {
    return h(
      Card,
      { title: '关注列表', meta: loading ? '读取中' : null },
      loading ? h(SkeletonLines, { lines: 3 }) : h(ErrorNote, { label: '关注列表', error }),
    );
  }
  const rows = watchlists.items ?? [];
  if (rows.length === 0) {
    return h(
      Card,
      { title: '关注列表', meta: '0 个' },
      h(Empty, { mark: '◇', title: '还没有关注列表' }),
    );
  }
  return h(
    Card,
    { title: '关注列表', meta: `${watchlists.total} 个` },
    h(
      'div',
      { className: 'luo-list' },
      rows.map(({ watchlist, memberCount, sourceHealth }) =>
        h(
          'div',
          { key: watchlist.id, className: 'luo-watch-row' },
          h(
            'div',
            null,
            h('div', { className: 'luo-watch-name' }, watchlist.name),
            h(
              'div',
              { className: 'luo-watch-meta' },
              `${WATCHLIST_KIND[watchlist.kind] ?? watchlist.kind} · ${watchlist.enabled ? '启用' : '停用'}`,
            ),
          ),
          h(
            'div',
            { style: { textAlign: 'right' } },
            h('div', { className: 'luo-mono', style: { fontSize: '12px' } }, `${memberCount} 只`),
            h(
              'div',
              { className: 'luo-watch-meta' },
              sourceHealth?.stale > 0 ? `${sourceHealth.stale} 待刷新` : '来源新鲜',
            ),
          ),
        ),
      ),
    ),
  );
};

const AdviceCard = ({ advice }) => {
  const decision = DECISION[advice.decision] ?? { label: advice.decision, tone: 'quiet' };
  const toneVar =
    decision.tone === 'quiet' ? 'var(--lu-line-strong)' : `var(--lu-${decision.tone})`;
  const title = subjectTitle(advice);
  return h(
    'article',
    { className: 'luo-advice', style: { '--lu-tone': toneVar } },
    h(
      'div',
      { className: 'luo-advice-h' },
      h(
        'div',
        null,
        h('div', { className: 'luo-advice-title' }, title),
        h(
          'div',
          { className: 'luo-advice-sub' },
          `${SUBJECT_KIND[advice.subjectKind] ?? advice.subjectKind} · ${HORIZON[advice.horizon] ?? advice.horizon} · ${when(advice.createdAt)}`,
        ),
      ),
      h(Pill, { tone: decision.tone === 'quiet' ? 'quiet' : decision.tone }, decision.label),
    ),
    h(
      'div',
      { className: 'luo-meter-row' },
      h(Meter, { value: advice.confidence }),
      h('span', { className: 'luo-meter-cap' }, `信心 ${Math.round(advice.confidence)}`),
    ),
    h(
      'p',
      { className: 'luo-advice-premise', style: { margin: 0 } },
      advice.reasoning?.premise ?? '—',
    ),
    h(
      'details',
      { className: 'luo-details' },
      h('summary', null, '证据 · 反证 · 风险'),
      h(
        'dl',
        { className: 'luo-dl' },
        h(
          'div',
          null,
          h('dt', null, '证据'),
          h(
            'dd',
            null,
            h(
              'ul',
              null,
              (advice.reasoning?.evidence ?? []).map((line, index) =>
                h('li', { key: index }, line),
              ),
            ),
          ),
        ),
        h(
          'div',
          null,
          h('dt', null, '反证'),
          h(
            'dd',
            null,
            h(
              'ul',
              null,
              (advice.reasoning?.counterEvidence ?? []).map((line, index) =>
                h('li', { key: index }, line),
              ),
            ),
          ),
        ),
        h(
          'div',
          null,
          h('dt', null, '风险'),
          h(
            'dd',
            null,
            h(
              'ul',
              null,
              (advice.risks ?? []).map((line, index) => h('li', { key: index }, line)),
            ),
          ),
        ),
        advice.validUntil
          ? h('div', null, h('dt', null, '有效期'), h('dd', null, when(advice.validUntil)))
          : null,
        h('div', null, h('dt', null, '数据时点'), h('dd', null, when(advice.dataAsOf))),
        h(
          'div',
          null,
          h('dt', null, '来源'),
          h(
            'dd',
            null,
            advice.provenance
              ? `${advice.provenance.generator ?? '—'}${advice.provenance.model ? ` · ${advice.provenance.model}` : ''}`
              : (advice.sourceTool ?? '—'),
          ),
        ),
      ),
    ),
    h(
      'p',
      { className: 'luo-fine', style: { margin: 0 } },
      (advice.disclaimers ?? [])[0] ?? '建议不等于交易。',
    ),
  );
};

const AdviceSection = ({ advice, loading, error }) => {
  if (!advice) {
    return h(
      Section,
      { title: '在期建议', meta: loading ? '读取中' : null, delay: 260 },
      loading
        ? h(
            'div',
            { className: 'luo-grid is-halves' },
            Array.from({ length: 2 }, (_, index) => h(Skeleton, { key: index, variant: 'card' })),
          )
        : h(ErrorNote, { label: '建议', error }),
    );
  }
  const rows = advice.advices ?? [];
  if (rows.length === 0) {
    return h(
      Section,
      { title: '在期建议', meta: '0 条', delay: 260 },
      h(
        Card,
        null,
        h(Empty, {
          mark: '✳',
          title: '还没有在期建议',
          hint: '买入 / 卖出 / 观察建议会带着证据与反证出现在这里。',
        }),
      ),
    );
  }
  return h(
    Section,
    {
      title: '在期建议',
      meta: `显示 ${Math.min(rows.length, 9)} / 共 ${advice.total} 条`,
      delay: 260,
    },
    h(
      'div',
      { className: 'luo-advice-grid' },
      rows.slice(0, 9).map((item) => h(AdviceCard, { key: item.id, advice: item })),
    ),
  );
};

const DataHealthLine = ({ status, loading }) => {
  if (!status) {
    return h('span', null, loading ? '正在核对数据健康…' : '数据健康不可用');
  }
  const providers = status.providers ?? [];
  const fresh = providers.filter((provider) => provider.freshness === 'fresh').length;
  const stale = providers.filter((provider) => provider.freshness === 'stale').length;
  const staleWatchlists = status.watchlistStale ?? [];
  const watch = status.watchHealth;
  return h(
    'span',
    null,
    '行情源 ',
    h('b', null, `${fresh} 新鲜`),
    stale > 0 ? ` · ${stale} 过期` : '',
    watch ? ` · 盯盘 ${WATCH_STATE[watch.state]?.label ?? watch.state}` : '',
    staleWatchlists.length > 0 ? ` · ${staleWatchlists.length} 个关注列表待刷新` : '',
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
          'span',
          { className: 'luo-region-time', role: 'status' },
          state.loading ? '读取中…' : state.loadedAt ? `读取 ${clock(state.loadedAt)}` : '尚未读取',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'luo-btn',
            onClick: state.refresh,
            'aria-label': `刷新${title}`,
          },
          state.error ? '重试' : '刷新',
        ),
      ),
    ),
    state.error
      ? h(
          'div',
          { className: 'luo-region-error' },
          h(ErrorNote, {
            error: {
              message:
                state.error.message ??
                (state.error.kind === 'permission_denied'
                  ? '当前分区未启用或无权读取，请核对数据配置。'
                  : '数据暂时不可用，请稍后重试。'),
            },
          }),
          state.loadedAt ? h('span', null, `展示上次成功数据 · ${clock(state.loadedAt)}`) : null,
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
  const watchlists = useOverviewSection('watchlists');
  const watchlist = useOverviewSection('watchlist', page);
  const triggers = useOverviewSection('triggers');
  const advice = useOverviewSection('advice');
  const health = useOverviewSection('health');
  const sectors = useOverviewSection('sectors');
  const news = useOverviewSection('news');
  const refreshers = [
    indices.refresh,
    sentiment.refresh,
    account.refresh,
    holdings.refresh,
    watchlists.refresh,
    watchlist.refresh,
    triggers.refresh,
    advice.refresh,
    health.refresh,
    sectors.refresh,
    news.refresh,
  ];
  const refresh = useCallback(() => {
    for (const read of refreshers) read();
  }, refreshers);
  const session = indices.session ?? health.session ?? account.session;
  const marketStatus = dataOf(health.results, 'get_market_data_status');
  const marketSession = session?.marketSession ?? marketStatus?.marketSession;
  const nextSessionStart = session?.nextSessionStart ?? null;
  useAutoRefresh({ marketSession, nextSessionStart, refresh });
  const refreshHint = autoRefreshHint(marketSession, nextSessionStart);
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
    Panel,
    { className: 'luo-overview' },
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
        h(Pill, { key: 'auto', tone: refreshHint.tone }, refreshHint.text),
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
          h('span', null, tab === 'watchlist' ? '已启用关注列表 · 合并去重' : '当前账户 · 未平仓'),
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
              h(MarketTable, {
                key: tab,
                quotes: dataOf(watchlist.results, 'batch_quote'),
                holdings: tab === 'holdings' ? held : undefined,
                triggers: triggerData,
                triggerState: triggers,
                onStock: (selected) => setStock({ ...selected, sourceLabel: selectedTitle }),
              }),
              tab === 'watchlist' && pagination
                ? h(
                    'div',
                    null,
                    pagination.incomplete
                      ? h(
                          'p',
                          { className: 'luo-fine luo-warn-text' },
                          '部分关注列表读取失败，仅展示已成功读取的成员。',
                        )
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
          'watchlists',
          '关注列表',
          watchlists,
          h(WatchlistsCard, { watchlists: dataOf(watchlists.results, 'list_watchlists') }),
        ),
        region(
          'advice',
          '在期建议',
          advice,
          h(
            'details',
            { className: 'luo-advice-fold', open: true },
            h('summary', null, '研究摘要 · 展开查看证据与反证'),
            h(AdviceSection, { advice: dataOf(advice.results, 'get_advice') }),
          ),
        ),
      ),
      h(
        'aside',
        { className: 'luo-terminal-side', 'aria-label': '市场动态' },
        region(
          'sentiment',
          '市场温度',
          sentiment,
          h(BreadthCard, { snapshot: dataOf(sentiment.results, 'get_ashare_sentiment')?.snapshot }),
        ),
        region(
          'sectors',
          '行业涨幅榜 · 前五',
          sectors,
          dataOf(sectors.results, 'fetch_sector_quotes')
            ? h(SectorRanking, { data: dataOf(sectors.results, 'fetch_sector_quotes') })
            : null,
        ),
        region('triggers', '今日触发', triggers, h(TriggersCard, { triggers: triggerData })),
        region(
          'news',
          '市场要闻',
          news,
          dataOf(news.results, 'fetch_news')
            ? h(NewsFeed, { data: dataOf(news.results, 'fetch_news') })
            : null,
        ),
      ),
    ),
    region('health', '数据状态', health, h(DataHealthLine, { status: marketStatus })),
    h(Footer, {
      left: '建议不等于交易，信心度不是概率。',
      right: '时间均为北京时间 · 各分区独立更新',
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
