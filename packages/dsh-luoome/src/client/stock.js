import { createElement as h, useEffect, useRef, useState } from 'react';
import { useStockDetail, useStockHistory } from './data.js';
import { bigMoney, int, money, points, when } from './format.js';
import { Card, ErrorNote, Pill, Refresh, SkeletonLines, Stat } from './primitives.js';

export function StockHistory({ marketView }) {
  const candles = marketView.candles;
  const status = marketView.dataStatus;
  if (!candles.length)
    return h('p', { className: 'luo-fine' }, '没有可绘制的历史 K 线。缺失历史保持未知。');
  const bottom = Math.min(...candles.map((bar) => bar.low));
  const top = Math.max(...candles.map((bar) => bar.high));
  const spread = top - bottom || 1;
  const y = (value) => 12 + ((top - value) / spread) * 132;
  const slot = 520 / candles.length;
  return h(
    'figure',
    { className: 'luo-stock-history' },
    h(
      'div',
      { className: 'luo-stock-history-caption' },
      h('strong', null, '历史日 K · 前复权'),
      h(
        Pill,
        { tone: status.retrieval === 'local-fallback' ? 'warn' : 'quiet' },
        status.retrieval === 'local-fallback' ? '本地保留历史' : '供应商历史',
      ),
    ),
    h(
      'svg',
      {
        viewBox: '0 0 560 176',
        role: 'img',
        'aria-label': `${candles[0].date} 至 ${candles.at(-1).date} 的真实日 K，共 ${candles.length} 根`,
        'data-stock-history': true,
      },
      [12, 78, 144].map((position) =>
        h('line', {
          key: position,
          x1: 20,
          x2: 540,
          y1: position,
          y2: position,
          className: 'luo-stock-history-grid',
        }),
      ),
      candles.map((bar, index) => {
        const x = 20 + (index + 0.5) * slot;
        return h(
          'g',
          { key: bar.date, className: bar.close >= bar.open ? 'is-up' : 'is-down' },
          h(
            'title',
            null,
            `${bar.date}：开 ${bar.open}，高 ${bar.high}，低 ${bar.low}，收 ${bar.close}；来源 ${bar.source}${bar.completeness === 'live' ? '；未收盘' : ''}`,
          ),
          h('line', {
            x1: x,
            x2: x,
            y1: y(bar.high),
            y2: y(bar.low),
            className: 'luo-stock-history-wick',
          }),
          h('rect', {
            x: x - Math.min(slot * 0.3, 5),
            y: Math.min(y(bar.open), y(bar.close)),
            width: Math.max(1, Math.min(slot * 0.6, 10)),
            height: Math.max(1, Math.abs(y(bar.open) - y(bar.close))),
            className: 'luo-stock-history-candle',
          }),
        );
      }),
      h('text', { x: 20, y: 169 }, candles[0].date),
      h('text', { x: 540, y: 169, textAnchor: 'end' }, candles.at(-1).date),
    ),
    h(
      'figcaption',
      { className: 'luo-fine' },
      `日线截止 ${status.barsAsOf ?? '未知'} · ${candles.length} 根实际 K 线 · 来源 ${status.sources.join('、') || '未提供'}。未补齐的交易日不生成 K 线；图表不代表历史回测。`,
    ),
    status.warnings.length
      ? h(
          'p',
          { className: 'luo-fine' },
          status.warnings.includes('bars-local-fallback')
            ? '供应商历史读取失败，正在展示本地保留的日线；数据范围可能不完整。'
            : status.warnings.includes('bars-insufficient')
              ? '日线样本不足，历史范围不完整。'
              : '保留工具返回的市场收盘、来源或覆盖限制，最新行情与日线可能来自不同时点。',
        )
      : null,
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
  const [showHistory, setShowHistory] = useState(false);
  const state = useStockDetail(stock.stockId);
  const history = useStockHistory(stock.stockId, showHistory);
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
              : '行情暂时不可用，可稍后重试。策略匹配依据仍可查看。',
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
        h('p', { className: 'luo-eyebrow' }, '个股详情'),
        h('h2', { id: 'luo-stock-title' }, stock.stockName),
        h('p', { className: 'luo-stock-code' }, stock.stockId),
      ),
      h(
        'button',
        { type: 'button', className: 'luo-btn', onClick: onClose, 'aria-label': '关闭个股详情' },
        '关闭',
      ),
    ),
    h(
      'div',
      { className: 'luo-stock-detail-body' },
      h(
        Card,
        { title: '行情快照', meta: h(Refresh, { loading: state.loading, onClick: state.refresh }) },
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
      ),
      h(
        Card,
        {
          title: '历史走势',
          meta: showHistory
            ? h(Refresh, { loading: history.loading, onClick: history.refresh })
            : '最近三个月 · 实际日 K',
        },
        !showHistory
          ? h(
              'button',
              { type: 'button', className: 'luo-btn', onClick: () => setShowHistory(true) },
              '读取历史日 K',
            )
          : history.loading
            ? h(
                'div',
                { role: 'status', 'aria-label': '正在读取历史日 K' },
                h(SkeletonLines, { lines: 3 }),
              )
            : history.data?.marketView?.ok
              ? h(StockHistory, { marketView: history.data.marketView.data })
              : h(ErrorNote, {
                  error: history.error ?? {
                    message:
                      history.data?.marketView?.error?.kind === 'permission_denied'
                        ? '当前配置未启用历史行情读取。'
                        : '历史日线不可用。不会从单次报价合成历史。',
                  },
                }),
      ),
      h(
        Card,
        { title: sourceLabel, meta: `第 ${version.version} 版` },
        h('p', { className: 'luo-stock-strategy-name' }, strategyName),
        h('p', { className: 'luo-fine' }, `匹配事实时间 ${when(result.dataAsOf)}`),
        h(
          'div',
          { className: 'luo-stats luo-stock-match-stats' },
          h(Stat, { k: '排名', v: int(result.rank) }),
          h(Stat, { k: '规则评分', v: result.score === undefined ? '—' : money(result.score) }),
        ),
        evidence,
      ),
      h(
        'p',
        { className: 'luo-strategy-note' },
        '行情快照与策略匹配可能来自不同时点。规则评分不代表成功概率，匹配标的仅供研究。',
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
      h('p', { className: 'luo-fine' }, '携带当前股票与策略来源，开启新的分析对话。'),
    ),
  );
}
