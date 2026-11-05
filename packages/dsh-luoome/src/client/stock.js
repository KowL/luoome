import { createElement as h, useEffect, useRef, useState } from 'react';
import { useStockDetail, useStockFinancial, useStockHistory, useStockProfile } from './data.js';
import { bigMoney, int, money, points, tradeDate, when } from './format.js';
import { Card, ErrorNote, Pill, Refresh, SkeletonLines, Stat } from './primitives.js';
import {
  stockFinancialSections,
  stockHistoryIndex,
  stockHistoryRows,
  xueqiuStockUrl,
} from './projection.js';

/** 个股档案事实：股东户数（最近一期）+ 所属板块清单。 */
function StockProfileFacts({ profile }) {
  const holders = profile.holders ?? [];
  const concepts = profile.concepts ?? [];
  const latest = holders[0];
  return h(
    'div',
    { className: 'luo-stock-profile' },
    latest
      ? h(
          'div',
          null,
          h('p', { className: 'luo-fine' }, `股东户数 · 统计截止 ${latest.endDate}`),
          h(
            'div',
            { className: 'luo-stats' },
            h(Stat, { k: '股东户数', v: int(latest.holderNum) }),
            h(Stat, {
              k: '较上期',
              v: latest.changePct === null ? '—' : points(latest.changePct * 100, 2, false),
            }),
            h(Stat, { k: '户均持股', v: int(latest.avgShares) }),
            h(Stat, { k: '户均市值', v: bigMoney(latest.avgMarketValue) }),
          ),
        )
      : h('p', { className: 'luo-fine' }, '上游未披露股东户数。'),
    concepts.length
      ? h(
          'div',
          { className: 'luo-stock-concepts' },
          h('p', { className: 'luo-fine' }, `所属板块 ${concepts.length} 个`),
          h(
            'ul',
            null,
            concepts.map((concept) =>
              h(
                'li',
                {
                  key: concept.code,
                  className: concept.precise ? 'is-precise' : 'is-broad',
                  title: concept.reason ?? undefined,
                },
                h('span', null, concept.name),
                concept.boardType
                  ? h('span', { className: 'luo-fine' }, ` ${concept.boardType}`)
                  : null,
                concept.precise ? null : h('span', { className: 'luo-fine' }, ' 宽泛'),
              ),
            ),
          ),
        )
      : h('p', { className: 'luo-fine' }, '上游未披露所属板块。'),
    h('p', { className: 'luo-fine' }, `来源 ${profile.source} · 读取于 ${when(profile.asOf)}`),
  );
}

export function StockHistory({ marketView }) {
  const [range, setRange] = useState('all');
  const [selectedDate, setSelectedDate] = useState(null);
  const candles = stockHistoryRows(marketView, range);
  const status = marketView.dataStatus;
  if (!candles.length)
    return h('p', { className: 'luo-fine' }, '没有可绘制的日 K。缺失交易日保持未知。');
  const selectedIndex = candles.findIndex((bar) => bar.date === selectedDate);
  const current = selectedIndex < 0 ? candles.length - 1 : selectedIndex;
  const selected = candles[current];
  const prices = candles
    .flatMap((bar) => [bar.low, bar.high, bar.ma20, bar.ma60])
    .filter(Number.isFinite);
  const bottom = Math.min(...prices);
  const top = Math.max(...prices);
  const spread = top - bottom || 1;
  const y = (value) => 16 + ((top - value) / spread) * 132;
  const maxVolume = Math.max(
    ...candles.map((bar) => (Number.isFinite(bar.volume) ? bar.volume : 0)),
  );
  const slot = 520 / candles.length;
  const x = (index) => 20 + (index + 0.5) * slot;
  const readout = (bar) =>
    `${bar.date}：开 ${money(bar.open)}，高 ${money(bar.high)}，低 ${money(bar.low)}，收 ${money(bar.close)}；成交量 ${Number.isFinite(bar.volume) ? `${int(bar.volume)} 股` : '缺失'}；成交额 ${Number.isFinite(bar.amount) ? bigMoney(bar.amount) : '缺失'}；MA20 ${bar.ma20 === null ? '不足期' : money(bar.ma20)}；MA60 ${bar.ma60 === null ? '不足期' : money(bar.ma60)}；来源 ${bar.source}${bar.completeness === 'live' ? '；未收盘' : ''}`;
  const maPath = (key) => {
    let connected = false;
    return candles
      .map((bar, index) => {
        if (bar[key] === null) {
          connected = false;
          return '';
        }
        const command = connected ? 'L' : 'M';
        connected = true;
        return `${command}${x(index)},${y(bar[key])}`;
      })
      .join(' ');
  };
  return h(
    'figure',
    { className: 'luo-stock-history' },
    h(
      'div',
      { className: 'luo-stock-history-caption' },
      h(
        Pill,
        { tone: status.retrieval === 'local-fallback' ? 'warn' : 'quiet' },
        status.retrieval === 'local-fallback' ? '本地保留日线' : '供应商日线',
      ),
    ),
    h(
      'div',
      { className: 'luo-stock-history-controls', role: 'group', 'aria-label': '日 K 范围' },
      [
        [30, '30 交易日'],
        [60, '60 交易日'],
        ['all', '全部已加载'],
      ].map(([value, label]) =>
        h(
          'button',
          {
            key: value,
            type: 'button',
            className: 'luo-btn',
            'aria-pressed': range === value,
            'data-stock-range': value,
            onClick: () => setRange(value),
          },
          label,
        ),
      ),
    ),
    h(
      'p',
      { className: 'luo-fine luo-stock-history-legend' },
      h('span', { className: 'luo-stock-ma20' }, 'MA20'),
      ' / ',
      h('span', { className: 'luo-stock-ma60' }, 'MA60'),
      ' · MA20/60 按完整已加载日线计算，不足期不画；含未收盘报价时为实时估算 · 成交量（股）',
    ),
    h(
      'svg',
      {
        viewBox: '0 0 560 252',
        role: 'group',
        tabIndex: 0,
        'aria-label': `${candles[0].date} 至 ${candles.at(-1).date} 的真实日 K 与成交量，共 ${candles.length} 根；左右方向键逐日读取，Home/End 跳至首末日`,
        'data-stock-history': true,
        onKeyDown: (event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          setSelectedDate(candles[stockHistoryIndex(event.key, current, candles.length)].date);
        },
        onPointerMove: (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const position = ((event.clientX - rect.left) / rect.width) * 560;
          const index = Math.max(
            0,
            Math.min(candles.length - 1, Math.floor((position - 20) / slot)),
          );
          setSelectedDate(candles[index].date);
        },
      },
      [16, 82, 148, 174, 226].map((position) =>
        h('line', {
          key: position,
          x1: 20,
          x2: 540,
          y1: position,
          y2: position,
          className: 'luo-stock-history-grid',
        }),
      ),
      h('text', { x: 20, y: 12 }, money(top)),
      h('text', { x: 540, y: 160, textAnchor: 'end' }, money(bottom)),
      h(
        'text',
        { x: 20, y: 170 },
        candles.some((bar) => Number.isFinite(bar.volume)) ? `量 ${int(maxVolume)} 股` : '量 缺失',
      ),
      candles.map((bar, index) =>
        h(
          'g',
          {
            key: bar.date,
            className: bar.close >= bar.open ? 'is-up' : 'is-down',
            onPointerEnter: () => setSelectedDate(bar.date),
          },
          h('title', null, readout(bar)),
          h('line', {
            x1: x(index),
            x2: x(index),
            y1: y(bar.high),
            y2: y(bar.low),
            className: 'luo-stock-history-wick',
          }),
          h('rect', {
            x: x(index) - Math.min(slot * 0.3, 5),
            y: Math.min(y(bar.open), y(bar.close)),
            width: Math.max(1, Math.min(slot * 0.6, 10)),
            height: Math.max(1, Math.abs(y(bar.open) - y(bar.close))),
            className: 'luo-stock-history-candle',
          }),
          Number.isFinite(bar.volume)
            ? h('rect', {
                x: x(index) - Math.min(slot * 0.3, 5),
                y: 226 - (maxVolume ? (bar.volume / maxVolume) * 48 : 0),
                width: Math.max(1, Math.min(slot * 0.6, 10)),
                height: maxVolume ? (bar.volume / maxVolume) * 48 : 0,
                className: 'luo-stock-history-volume',
                'data-volume-date': bar.date,
              })
            : null,
        ),
      ),
      ['ma20', 'ma60'].map((key) =>
        h('path', {
          key,
          d: maPath(key),
          fill: 'none',
          stroke: key === 'ma20' ? 'var(--lu-accent, #65b9a5)' : 'var(--lu-warn, #d9ac65)',
          strokeWidth: 1.5,
          className: `luo-stock-${key}`,
        }),
      ),
      h('line', {
        x1: x(current),
        x2: x(current),
        y1: 16,
        y2: 226,
        className: 'luo-stock-history-cursor',
        stroke: 'currentColor',
        strokeDasharray: '3 4',
      }),
      h('text', { x: 20, y: 246 }, candles[0].date),
      h('text', { x: 540, y: 246, textAnchor: 'end' }, candles.at(-1).date),
    ),
    h(
      'p',
      {
        className: 'luo-fine luo-stock-history-readout',
        'aria-live': 'polite',
        'aria-atomic': true,
      },
      readout(selected),
    ),
    h(
      'figcaption',
      { className: 'luo-fine' },
      `日线截止 ${status.barsAsOf ?? '未知'} · 显示 ${candles.length} / 已加载 ${marketView.candles.length} 根实际 K 线 · 前复权 · 来源 ${status.sources.join('、') || '未提供'}。未补齐的交易日不生成 K 线；范围按实际日线根数裁取，全部仅指已加载日线，不提供回测结论。`,
    ),
    status.warnings.length
      ? h(
          'p',
          { className: 'luo-fine' },
          status.warnings.includes('bars-local-fallback')
            ? '供应商日 K 读取失败，正在展示本地保留的日线；数据范围可能不完整。'
            : status.warnings.includes('bars-insufficient')
              ? '日线样本不足，区间不完整。'
              : '保留工具返回的市场收盘、来源或覆盖限制，最新行情与日线可能来自不同时点。',
        )
      : null,
  );
}

const financialDate = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '缺失');
const FINANCIAL_INDICATORS = [
  ['calculate_operating_income_yoy_growth_ratio', '营业收入同比'],
  ['calculate_parent_holder_net_profit_yoy_growth_ratio', '归母净利润同比'],
  ['index_weighted_avg_roe', '加权平均净资产收益率'],
  ['sale_gross_margin', '销售毛利率'],
  ['assets_debt_ratio', '资产负债率'],
];

export function StockFinancialFacts({ snapshot }) {
  return h(
    'div',
    { className: 'luo-stock-financial', 'data-stock-financial': true },
    h(Pill, { tone: 'warn' }, '当前数据商视图 · 非 PIT'),
    h(
      'p',
      { className: 'luo-fine' },
      `${snapshot.viewKind} · PIT ${snapshot.pitStatus}；不用于历史回测或生产基本面评分。季报累计值保持原口径。`,
    ),
    h(
      'p',
      { className: 'luo-fine' },
      `报告期末 ${financialDate(snapshot.periodEnd)} · 披露日 ${financialDate(snapshot.reportDate)}`,
    ),
    stockFinancialSections(snapshot).map((section) =>
      h(
        'section',
        { key: section.key, className: 'luo-stock-financial-section' },
        h('h4', null, section.title),
        h(
          'p',
          { className: 'luo-fine' },
          `报告期 ${section.period ?? '缺失'} · 期末 ${financialDate(section.periodEnd)} · 披露日 ${financialDate(section.reportDate)}`,
        ),
        h(
          'div',
          { className: 'luo-stock-quote-grid' },
          section.rows.map((row) =>
            h(Stat, {
              key: row.key,
              k: row.label,
              v:
                row.value === null
                  ? '缺失'
                  : row.unit === 'CNY/share'
                    ? `${money(row.value)} 元/股`
                    : bigMoney(row.value),
            }),
          ),
        ),
      ),
    ),
    h(
      'section',
      { className: 'luo-stock-financial-section' },
      h('h4', null, '当前估值'),
      h(
        'div',
        { className: 'luo-stock-quote-grid' },
        [
          ['peTtm', 'PE TTM'],
          ['peMrq', 'PE MRQ'],
          ['pbMrq', 'PB MRQ'],
          ['psTtm', 'PS TTM'],
          ['pcfTtm', 'PCF TTM'],
        ].map(([key, label]) =>
          h(Stat, {
            key,
            k: label,
            v: snapshot.valuation?.[key] == null ? '缺失' : money(snapshot.valuation[key]),
          }),
        ),
      ),
    ),
    h(
      'section',
      { className: 'luo-stock-financial-section' },
      h('h4', null, '财务指标'),
      h(
        'p',
        { className: 'luo-fine' },
        `指标报告期 ${snapshot.indicators?.report ?? '缺失'} · 百分数字段按上游百分点显示`,
      ),
      h(
        'div',
        { className: 'luo-stock-quote-grid' },
        FINANCIAL_INDICATORS.map(([key, label]) => {
          const indicator = snapshot.indicators?.indicators.find(
            (item) => item.indicatorId === key,
          );
          return h(Stat, {
            key,
            k: label,
            v:
              indicator?.value == null
                ? '缺失'
                : indicator.unit === 'percent-points'
                  ? points(indicator.value, 2, false)
                  : money(indicator.value),
          });
        }),
      ),
    ),
    h(
      'p',
      { className: 'luo-fine' },
      `来源 ${snapshot.source} · 观察时间 ${snapshot.observedAt ? when(snapshot.observedAt) : '缺失'} · 获取时间 ${when(snapshot.fetchedAt)}`,
    ),
    h(
      'p',
      { className: 'luo-fine' },
      `上游缺失字段：${snapshot.missingFields.join('、') || '未标记'}；问题：${snapshot.issues.join('；') || '未标记'}。估值为最新快照，不代表与各报表同刻更新。`,
    ),
  );
}

export function StockDetail({
  stock,
  result,
  version,
  strategyName,
  sourceLabel = '策略匹配',
  evidence,
  onClose,
  onAnalyze,
}) {
  const dialog = useRef(null);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);
  const state = useStockDetail(stock.stockId);
  const history = useStockHistory(stock.stockId);
  const profile = useStockProfile(stock.stockId);
  const financial = useStockFinancial(stock.stockId);
  const financialResponse = financial.data?.financial;
  const profileResponse = profile.data?.profile;
  const profileItem = profileResponse?.ok ? profileResponse.data : null;
  const profileError =
    profile.error ??
    (!profile.loading && !profileItem
      ? {
          message:
            profileResponse?.error?.kind === 'permission_denied'
              ? '当前配置未启用个股档案读取。'
              : '个股档案不可用。',
        }
      : null);
  const financialError =
    financial.error ??
    (!financial.loading && !financialResponse?.ok
      ? {
          message:
            financialResponse?.error?.kind === 'permission_denied'
              ? '当前配置未启用财务快照读取。'
              : financialResponse?.error?.kind === 'invalid_input'
                ? '当前未配置财务快照数据源；请核对数据源配置。'
                : '财务快照不可用，请稍后重试。',
        }
      : null);
  const kline = history.loading
    ? h('div', { role: 'status', 'aria-label': '正在读取日 K' }, h(SkeletonLines, { lines: 3 }))
    : history.error
      ? h(ErrorNote, { error: history.error })
      : history.data?.marketView?.ok
        ? h(StockHistory, { marketView: history.data.marketView.data })
        : h(ErrorNote, {
            error: {
              message:
                history.data?.marketView?.error?.kind === 'permission_denied'
                  ? '当前配置未启用日 K 读取。'
                  : '日 K 不可用。不会用单次报价合成走势。',
            },
          });
  const refreshAll = () => {
    state.refresh();
    history.refresh();
    profile.refresh();
    financial.refresh();
  };
  const refreshing = state.loading || history.loading || profile.loading || financial.loading;
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  const response = state.data?.quote;
  const item = response?.ok ? response.data : null;
  const quote = item?.quote ?? null;
  const quoteError =
    state.error ??
    (!state.loading && !quote
      ? {
          message:
            response?.error?.kind === 'permission_denied'
              ? '当前配置未启用个股行情读取。'
              : '行情暂时不可用，可稍后重试。',
        }
      : null);
  const analyze = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setAnalysisError(null);
    try {
      await onAnalyze();
    } catch {
      setAnalysisError({ message: '分析请求未能确认发送，请先核对对话状态再重试。' });
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const xueqiu = xueqiuStockUrl(stock.stockId);
  return h(
    'dialog',
    {
      ref: dialog,
      className: 'luo-stock-detail',
      'aria-labelledby': 'luo-stock-title',
      onCancel: (event) => {
        event.preventDefault();
        onClose();
      },
      onClick: (event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      },
    },
    h(
      'header',
      { className: 'luo-stock-detail-head' },
      h(
        'div',
        null,
        h('h2', { id: 'luo-stock-title' }, stock.stockName),
        h(
          'p',
          { className: 'luo-stock-code' },
          xueqiu === null
            ? stock.stockId
            : h(
                'a',
                {
                  className: 'luo-stock-code-link',
                  href: xueqiu,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  title: `在雪球查看 ${stock.stockId}`,
                  'aria-label': `在雪球查看 ${stock.stockId}`,
                },
                stock.stockId,
                h('span', { className: 'luo-stock-code-external', 'aria-hidden': 'true' }, '↗'),
              ),
        ),
      ),
      h(
        'div',
        { className: 'luo-stock-head-actions' },
        h(Refresh, {
          loading: refreshing,
          onClick: refreshAll,
          label: '刷新',
          ariaLabel: '刷新个股数据',
        }),
        h(
          'button',
          { type: 'button', className: 'luo-btn', onClick: onClose, 'aria-label': '关闭个股详情' },
          '关闭',
        ),
      ),
    ),
    h(
      'div',
      { className: 'luo-stock-detail-body' },
      h(
        Card,
        null,
        state.loading
          ? h(
              'div',
              { role: 'status', 'aria-label': '正在读取个股行情' },
              h(SkeletonLines, { lines: 4 }),
            )
          : null,
        quoteError ? h(ErrorNote, { error: quoteError }) : null,
        quote
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'luo-stock-price-row' },
                h('strong', { className: 'luo-stock-price' }, money(quote.close)),
                h('span', { className: 'luo-fine' }, '元'),
                h(
                  Pill,
                  {
                    tone:
                      item.retrieval === 'local-fallback' || item.freshness === 'stale'
                        ? 'warn'
                        : 'quiet',
                  },
                  item.retrieval === 'local-fallback' ? '本地快照' : '供应商行情',
                ),
                item.freshness === 'stale' ? h(Pill, { tone: 'warn' }, '数据已过时') : null,
              ),
              h(
                'p',
                { className: 'luo-stock-quote-time' },
                `${quote.timestampSource === 'upstream' ? '行情时间' : '抓取时间（未提供交易时点）'} ${when(quote.observedAt)} · 来源 ${quote.source}`,
              ),
              h(
                'div',
                { className: 'luo-stock-quote-grid' },
                [
                  ['开盘', money(quote.open)],
                  ['最高', money(quote.high)],
                  ['最低', money(quote.low)],
                  ['昨收', money(quote.prevClose)],
                  ['成交量（股）', int(quote.volume)],
                  ['成交额', bigMoney(quote.amount)],
                  ['换手率', points(quote.turnoverRatePct, 2, false)],
                  ['总市值', bigMoney(quote.totalMarketCap)],
                  ['市盈率 TTM', money(quote.peTtm)],
                  ['市净率', money(quote.pb)],
                ].map(([label, value]) => h(Stat, { key: label, k: label, v: value })),
              ),
              h('p', { className: 'luo-fine' }, `行情读取于 ${when(quote.fetchedAt)}`),
            )
          : null,
        h('div', { className: 'luo-stock-kline' }, kline),
      ),
      h(
        Card,
        null,
        profile.loading
          ? h(
              'div',
              { role: 'status', 'aria-label': '正在读取个股档案' },
              h(SkeletonLines, { lines: 3 }),
            )
          : profileError
            ? h(ErrorNote, { error: profileError })
            : profileItem
              ? h(StockProfileFacts, { profile: profileItem })
              : null,
      ),
      h(
        Card,
        null,
        financial.loading
          ? h(
              'div',
              { role: 'status', 'aria-label': '正在读取财务快照' },
              h(SkeletonLines, { lines: 3 }),
            )
          : financialError
            ? h(ErrorNote, { error: financialError })
            : financialResponse?.ok
              ? h(StockFinancialFacts, { snapshot: financialResponse.data })
              : null,
      ),
      result && version
        ? h(
            Card,
            null,
            h(
              'p',
              { className: 'luo-stock-source-meta' },
              `${sourceLabel} · 第 ${version.version} 版`,
            ),
            h('p', { className: 'luo-stock-strategy-name' }, strategyName),
            h('p', { className: 'luo-fine' }, `匹配事实时间 ${tradeDate(result.dataAsOf)}`),
            h(
              'div',
              { className: 'luo-stats luo-stock-match-stats' },
              h(Stat, { k: '排名', v: int(result.rank) }),
              h(Stat, { k: '规则评分', v: result.score === undefined ? '—' : money(result.score) }),
            ),
            evidence,
          )
        : h(Card, null, h('p', { className: 'luo-stock-source-meta' }, sourceLabel), evidence),
      h(
        'p',
        { className: 'luo-strategy-note' },
        result
          ? '行情与策略匹配可能来自不同时点。规则评分不代表成功概率，匹配标的仅供研究。'
          : '行情与账户事实可能来自不同时点。关注或持仓不代表买入建议。',
      ),
    ),
    h(
      'footer',
      { className: 'luo-stock-detail-foot' },
      analysisError ? h(ErrorNote, { error: analysisError }) : null,
      h(
        'button',
        {
          type: 'button',
          className: 'luo-btn luo-stock-analyze',
          disabled: busy,
          onClick: analyze,
          'data-analyze-stock': stock.stockId,
        },
        busy ? '正在打开分析对话…' : '在对话中分析这只股票',
      ),
      h('p', { className: 'luo-fine' }, '携带当前股票与来源，开启新的分析对话。'),
    ),
  );
}
