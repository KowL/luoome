import { createElement as h } from 'react';

import { dataOf, errorOf, usePanelState } from './data.js';
import {
  bigMoney,
  clock,
  DECISION,
  DELIVERY,
  day,
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
  Refresh,
  Section,
  Skeleton,
  SkeletonLines,
  Stamp,
  Stat,
} from './primitives.js';

const SESSION_TONE = {
  'pre-open': 'warn',
  trading: 'up',
  'midday-break': 'quiet',
  closed: 'quiet',
  'non-trading-day': 'quiet',
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
    h('div', { className: 'luo-index-src' }, `${quote.source} · ${clock(quote.ts)}`),
  );
};

const IndexStrip = ({ snapshot, loading, error }) => {
  const values = snapshot?.indexes?.values ?? [];
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
    h(ErrorNote, { label: '指数', error }),
    h(DimensionHint, { dimension: snapshot?.indexes }),
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

const HoldingsTable = ({ holdings, loading, error }) => {
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

export function OverviewPanel() {
  const { results, loading, panelError, loadedAt, refresh } = usePanelState('overview');
  const holdings = dataOf(results, 'list_holdings');
  const triggers = dataOf(results, 'list_watch_triggers');
  const advice = dataOf(results, 'get_advice');
  const watchlists = dataOf(results, 'list_watchlists');
  const sentiment = dataOf(results, 'get_ashare_sentiment')?.snapshot;
  const marketStatus = dataOf(results, 'get_market_data_status');
  const session = marketStatus?.marketSession;

  const side = [
    session
      ? h(
          Pill,
          { key: 'session', tone: SESSION_TONE[session] ?? 'quiet', dot: true },
          MARKET_SESSION[session] ?? session,
        )
      : null,
    h(Stamp, { key: 'stamp', label: '更新', value: clock(loadedAt) }),
    h(Refresh, { key: 'refresh', loading, onClick: refresh }),
  ];

  return h(
    Panel,
    null,
    h(Head, {
      eyebrow: 'LUOOME / 看盘',
      title: '看盘',
      subtitle: `${day(loadedAt)} · 市场温度、持仓变化与今日触发，一屏对齐`,
      side,
    }),
    panelError
      ? h(
          'div',
          { style: { marginTop: '16px' } },
          h(ErrorNote, { label: '事实读取', error: panelError }),
        )
      : null,
    h(
      Section,
      {
        title: '核心指数',
        meta: sentiment?.indexes?.provenance?.[0]?.provider ?? '实时行情',
        delay: 40,
      },
      h(IndexStrip, {
        snapshot: sentiment,
        loading,
        error: errorOf(results, 'get_ashare_sentiment'),
      }),
    ),
    h(
      Section,
      { delay: 90 },
      h(BreadthCard, {
        snapshot: sentiment,
        loading,
        error: errorOf(results, 'get_ashare_sentiment'),
      }),
    ),
    h(
      Section,
      { title: '账户', meta: holdings ? `市值 ${money(holdings.totalValue)}` : null, delay: 140 },
      h(
        'div',
        { className: 'luo-grid is-kpi' },
        h(Kpi, {
          label: '持仓市值',
          value: holdings ? money(holdings.totalValue) : '—',
          sub: holdings ? `成本 ${money(holdings.totalCost)}` : '',
        }),
        h(Kpi, {
          label: '浮动盈亏',
          value: holdings ? signedMoney(holdings.totalPnL) : '—',
          tone: holdings ? toneOf(holdings.totalPnL) : undefined,
          sub: holdings ? ratio(holdings.totalPnLPct) : '',
        }),
        h(Kpi, {
          label: '今日盈亏',
          value: holdings ? signedMoney(holdings.totalTodayPnl) : '—',
          tone: holdings ? toneOf(holdings.totalTodayPnl) : undefined,
          sub: holdings ? ratio(holdings.totalTodayPnlPct) : '',
        }),
        h(Kpi, {
          label: '持仓',
          value: holdings ? `${int(holdings.holdings?.length ?? 0)} 只` : '—',
          sub: holdings?.status === 'active' ? '未平仓' : '',
        }),
      ),
    ),
    h(
      Section,
      { delay: 190 },
      h(
        'div',
        { className: 'luo-grid is-two' },
        h(HoldingsTable, { holdings, loading, error: errorOf(results, 'list_holdings') }),
        h(
          'div',
          { className: 'luo-grid', style: { gridTemplateColumns: 'minmax(0, 1fr)' } },
          h(TriggersCard, { triggers, loading, error: errorOf(results, 'list_watch_triggers') }),
          h(WatchlistsCard, { watchlists, loading, error: errorOf(results, 'list_watchlists') }),
        ),
      ),
    ),
    h(AdviceSection, { advice, loading, error: errorOf(results, 'get_advice') }),
    h(Footer, {
      left: h(
        'span',
        null,
        h('b', null, '只读事实投影'),
        ' · 数值直接来自工具输出，不做二次计算；建议不等于交易，信心度不是概率。',
        panelError
          ? h('span', { style: { display: 'block', marginTop: '4px' } }, `行情面：${panelError}`)
          : null,
      ),
      right: h(
        'span',
        null,
        h(DataHealthLine, {
          status: marketStatus,
          loading,
          error: errorOf(results, 'get_market_data_status'),
        }),
        h('span', { style: { display: 'block' } }, relative(loadedAt)),
      ),
    }),
  );
}
