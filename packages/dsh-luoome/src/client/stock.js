import { createElement as h, useEffect, useRef, useState } from 'react';
import { useStockDetail, useStockHistory, useStockProfile } from './data.js';
import { bigMoney, int, money, points, tradeDate, when } from './format.js';
import { Card, cx, ErrorNote, Pill, Refresh, SkeletonLines, Stat } from './primitives.js';
import { stockKlineModel, stockKlineWarning, xueqiuStockUrl } from './stock-chart.js';

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

export function StockKline({ marketView }) {
  const model = stockKlineModel(marketView);
  if (model === null)
    return h(
      'p',
      { className: 'luo-fine' },
      '没有可绘制的日 K。缺失交易日保持未知，不以单次报价合成走势。',
    );
  const warning = stockKlineWarning(model.warnings);
  return h(
    'figure',
    { className: 'luo-kline' },
    h(
      'div',
      { className: 'luo-kline-caption' },
      h(
        Pill,
        { tone: model.retrieval === 'local-fallback' ? 'warn' : 'quiet' },
        model.retrieval === 'local-fallback' ? '本地保留日线' : '供应商日线',
      ),
      model.live ? h(Pill, { tone: 'accent' }, '最新日 K 未收盘') : null,
      h('span', { className: 'luo-fine' }, `最近 ${model.range.count} 根`),
    ),
    h(
      'div',
      { className: 'luo-kline-stats' },
      h(Stat, { k: '最新收盘', v: money(model.lastClose) }),
      h(Stat, { k: '区间最高', v: money(model.range.high) }),
      h(Stat, { k: '区间最低', v: money(model.range.low) }),
    ),
    h(
      'p',
      { className: 'luo-kline-range' },
      `首末收盘 ${money(model.firstClose)} → ${money(model.lastClose)}`,
    ),
    model.indicators.length === 0
      ? null
      : h(
          'p',
          { className: 'luo-kline-ma' },
          '均线（最新） ',
          model.indicators.map(([name, value]) => `${name} ${money(value)}`).join(' · '),
        ),
    h(
      'svg',
      {
        viewBox: `0 0 ${model.width} ${model.height}`,
        role: 'img',
        'aria-label': `${model.range.from} 至 ${model.range.to} 的真实日 K，共 ${model.range.count} 根，前复权`,
        'data-stock-kline': true,
      },
      model.priceTicks.map((tick, index) =>
        h(
          'g',
          { key: index },
          h('line', {
            x1: model.plotLeft,
            x2: model.plotRight,
            y1: tick.y,
            y2: tick.y,
            className: 'luo-kline-grid',
          }),
          h(
            'text',
            {
              x: model.plotRight + 6,
              y: tick.y + 3,
              textAnchor: 'start',
              className: 'luo-kline-axis',
            },
            tick.label,
          ),
        ),
      ),
      h('line', {
        x1: model.plotLeft,
        x2: model.plotRight,
        y1: model.lastCloseY,
        y2: model.lastCloseY,
        className: 'luo-kline-last',
      }),
      h(
        'text',
        {
          x: model.plotLeft,
          y: model.volumeTop - 5,
          textAnchor: 'start',
          className: 'luo-kline-axis',
        },
        '成交量',
      ),
      model.bars.map((bar) =>
        h(
          'g',
          { key: bar.key, className: bar.up ? 'is-up' : 'is-down' },
          h('title', null, bar.title),
          h('line', {
            x1: bar.x,
            x2: bar.x,
            y1: bar.highY,
            y2: bar.lowY,
            className: 'luo-kline-wick',
          }),
          h('rect', {
            x: bar.bodyX,
            y: bar.bodyY,
            width: bar.bodyWidth,
            height: bar.bodyHeight,
            className: cx('luo-kline-body', bar.live && 'is-live'),
          }),
          h('rect', {
            x: bar.bodyX,
            y: bar.volumeY,
            width: bar.bodyWidth,
            height: bar.volumeHeight,
            className: 'luo-kline-volume',
            'data-kline-volume': true,
          }),
        ),
      ),
      model.dateTicks.map((tick) =>
        h(
          'text',
          {
            key: tick.key,
            x: tick.x,
            y: model.height - 4,
            textAnchor: tick.anchor,
            className: 'luo-kline-axis',
          },
          tick.label,
        ),
      ),
    ),
    h(
      'figcaption',
      { className: 'luo-fine' },
      `日线截止 ${model.barsAsOf ?? '未知'} · 前复权 · 来源 ${model.sources.join('、') || '未提供'}。未补齐的交易日不生成 K 线；日 K 只反映区间真实成交，不提供回测结论。`,
    ),
    warning === null ? null : h('p', { className: 'luo-fine' }, warning),
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
  const kline = history.loading
    ? h('div', { role: 'status', 'aria-label': '正在读取日 K' }, h(SkeletonLines, { lines: 3 }))
    : history.error
      ? h(ErrorNote, { error: history.error })
      : history.data?.marketView?.ok
        ? h(StockKline, { marketView: history.data.marketView.data })
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
  };
  const refreshing = state.loading || history.loading || profile.loading;
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
        : h(Card, null, h('p', { className: 'luo-stock-source-meta' }, sourceLabel)),
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
