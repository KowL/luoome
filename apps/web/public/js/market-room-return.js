/* apps/web/public/js/market-room-return.js —— 作战室 ↔ 个股页的返回现场（ticket #44）。
 *
 * 设计要点：
 * - 从板块详情 / 核心股进个股页时，把当前作战室 hash 原样放进 `returnTo`，
 *   返回时重新走同一个 hash（at / tab / kind / sort / window / sector / compare 全保留）；
 * - 只接受 `market-room` 开头的站内深链接，其它值忽略，不把 returnTo 变成开放跳转；
 * - 行情页切换周期 / 粒度时保留 returnTo，从顶栏搜索打开别的股票则不带；
 * - 浏览器前进 / 后退依赖 hash 历史，不需要额外状态。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { parseReplayAt, replayClockLabel } from './market-room-replay.js';

const ROOM_RETURN_PREFIX = 'market-room';
const RETURN_TO_MAX_LENGTH = 4000;
const TAB_LABELS = {
  overview: '总览',
  sectors: '板块追踪',
  turnover: '成交分布',
  events: '盘中事件',
};

const stripHash = (hash) =>
  String(hash ?? '')
    .replace(/^#/, '')
    .trim();

/** returnTo 只接受作战室站内 hash：`market-room` 或 `market-room?...`。 */
const validRoomReturn = (value) =>
  value.length <= RETURN_TO_MAX_LENGTH &&
  (value === ROOM_RETURN_PREFIX || value.startsWith(`${ROOM_RETURN_PREFIX}?`));

/** 从行情页 hash 读取 returnTo；缺省 / 非法值返回 null（不渲染返回入口）。 */
const returnToFromHash = (hash = globalThis.location?.hash ?? '') => {
  const raw = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '').get('returnTo');
  if (raw === null) return null;
  const value = stripHash(raw);
  return validRoomReturn(value) ? value : null;
};

/** 个股页深链接：默认保持既有 `#market?stockId=...&range=3m` 口径。 */
const stockHref = (stockId, returnTo = null) => {
  const base = `#market?stockId=${encodeURIComponent(stockId)}&range=3m`;
  return returnTo === null || returnTo === undefined || returnTo === ''
    ? base
    : `${base}&returnTo=${encodeURIComponent(returnTo)}`;
};

/** 行情周期 / 粒度切换时把 returnTo 续到新 hash；没有现场时原样返回。 */
const appendReturnTo = (hash, returnTo) => {
  if (returnTo === null || returnTo === undefined || returnTo === '') return hash;
  return `${hash}&returnTo=${encodeURIComponent(returnTo)}`;
};

/** 返回入口文案：说明回到哪个视图 / 是否在回放，避免只写「返回」。 */
const returnLabel = (returnTo) => {
  const raw = stripHash(returnTo);
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  if (query === '') return '返回作战室';
  const params = new URLSearchParams(query);
  const tab = params.get('tab') ?? 'overview';
  const sectorSelected = (params.get('sector') ?? '').trim() !== '';
  const context =
    tab === 'sectors' && sectorSelected ? '板块详情' : (TAB_LABELS[tab] ?? TAB_LABELS.overview);
  const at = parseReplayAt(params.get('at') ?? undefined);
  const replay = at === null ? null : `回放 ${replayClockLabel(at)}`;
  return replay === null ? `返回作战室 · ${context}` : `返回作战室 · ${context} · ${replay}`;
};

export { appendReturnTo, returnLabel, returnToFromHash, stockHref };
