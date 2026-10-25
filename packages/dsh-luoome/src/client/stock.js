import { createElement as h, useEffect, useRef, useState } from 'react';
import { useStockDetail } from './data.js';
import { bigMoney, int, money, points, when } from './format.js';
import { Card, ErrorNote, Pill, Refresh, SkeletonLines, Stat } from './primitives.js';

export function StockDetail({
  stock,
  result,
  version,
  strategyName,
  evidence,
  onClose,
  onAnalyze,
}) {
  const dialog = useRef(null);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);
  const state = useStockDetail(stock.stockId);
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
        { title: '策略匹配', meta: `第 ${version.version} 版` },
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
