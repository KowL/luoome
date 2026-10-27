// dsh-luoome 看盘面板自动刷新节奏：节奏只由服务端给的交易时段决定，
// 客户端不判断交易日历、不重算业务数字，只负责算出下一次该等多久。
//
// 这里只放纯函数（可在 Node 下单测）；React 调度在 data.js 的 useAutoRefresh。

export const TRADING_REFRESH_INTERVAL_MS = 60_000;
export const IDLE_REFRESH_INTERVAL_MS = 300_000;

const toTimestamp = (value) => {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  return null;
};

/**
 * 下一次自动刷新的等待时长。
 *
 * 盘中最快按 TRADING_REFRESH_INTERVAL_MS 排期；非交易时段等到服务端给的下次开盘
 * 时间；拿不到可用开盘时间（老服务端无 session、字段缺失或已过期）时兜底
 * IDLE_REFRESH_INTERVAL_MS。
 */
export const nextRefreshDelayMs = ({ marketSession, nextSessionStart, now } = {}) => {
  if (marketSession === 'trading') return TRADING_REFRESH_INTERVAL_MS;
  const at = toTimestamp(now) ?? Date.now();
  const start = toTimestamp(nextSessionStart);
  if (start !== null && start > at) return start - at;
  return IDLE_REFRESH_INTERVAL_MS;
};
