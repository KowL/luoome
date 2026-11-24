import type { Quote } from '@luoome/core';

/** 开盘相对昨收的方向；平开区间用于吸收集合竞价的最小噪声。 */
export type OpenDirection = 'low' | 'flat' | 'high';

export interface OpeningFact {
  readonly open: number;
  readonly prevClose: number;
  readonly openChangePct: number;
  readonly direction: OpenDirection;
  readonly label: '低开' | '平开' | '高开';
}

export type OpeningFactResult =
  | { readonly status: 'ok'; readonly data: OpeningFact }
  | { readonly status: 'unavailable'; readonly reason: string };

/** |openChangePct| 不超过该值视为平开。 */
export const OPEN_FLAT_TOLERANCE_PCT = 0.1;

/**
 * 开盘方向只能由 open 与上一交易日收盘价派生。
 * 缺 prevClose 时保持 unavailable，不用当日 open 顶替昨收（CONTEXT.md 口径）。
 */
export const deriveOpeningFact = (quote: Pick<Quote, 'open' | 'prevClose'>): OpeningFactResult => {
  const prevClose = quote.prevClose;
  if (prevClose === undefined || !Number.isFinite(prevClose) || prevClose <= 0) {
    return { status: 'unavailable', reason: '缺少上一交易日收盘价，无法判断开盘方向' };
  }
  const open = quote.open;
  if (!Number.isFinite(open) || open <= 0) {
    return { status: 'unavailable', reason: '开盘价不可用，无法判断开盘方向' };
  }
  const openChangePct = ((open - prevClose) / prevClose) * 100;
  const direction: OpenDirection =
    Math.abs(openChangePct) <= OPEN_FLAT_TOLERANCE_PCT
      ? 'flat'
      : openChangePct < 0
        ? 'low'
        : 'high';
  return {
    status: 'ok',
    data: {
      open,
      prevClose,
      openChangePct,
      direction,
      label: direction === 'flat' ? '平开' : direction === 'low' ? '低开' : '高开',
    },
  };
};
