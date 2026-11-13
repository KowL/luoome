/* apps/web/public/js/market-room-replay.js —— 作战室统一时间轴（ticket #43）。
 *
 * 设计要点：
 * - hash 里的 `at` 是四个视图唯一的时点来源：ISO 或 HH:mm（按 Asia/Shanghai 解释为当天），
 *   缺省 = 最新；切换视图保留同一个 at，页面刷新读同一时点；
 * - 回放只把 at 放进 GET 查询，不触发采集、不写入事件；「回到最新」清除 at；
 * - 点事件行把 at 设为该事件的检测时点（sampledAt），四个视图随之重取；
 * - 可回放范围从最早可信采样起算：更早的时点没有批次，页面给出明确不可回放原因，不伪造。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const CLOCK_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T/;
const ISO_ZONE_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const pad = (value) => String(value).padStart(2, '0');

/** 上海日期 YYYY-MM-DD；A 股无夏令时，直接按 +8 偏移换算。 */
const shanghaiDate = (date) => {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
};

/** 上海时钟 HH:mm；非法时间返回 '--'。 */
const replayClockLabel = (at) => {
  if (at === null || at === undefined) return '--';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/**
 * 时点解析：带日期的 ISO 原样解析；HH:mm / HH:mm:ss 按上海当天解释。
 * 非法值与空值都返回 null（= 最新模式），不把无法解释的输入当成时点。
 */
const parseReplayAt = (raw, now = new Date()) => {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '') return null;
  if (ISO_DATE_TIME_PATTERN.test(value)) {
    // 不带时区的 ISO 按上海墙上时间解释，避免跟随浏览器本地时区。
    const parsed = new Date(ISO_ZONE_PATTERN.test(value) ? value : `${value}+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const match = CLOCK_PATTERN.exec(value);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? '0');
  if (hour > 23 || minute > 59 || second > 59) return null;
  const parsed = new Date(`${shanghaiDate(now)}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const hashParams = (hash = window.location.hash) =>
  new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');

/** 当前 hash 的回放时点；缺省或非法时点返回 null（最新模式）。 */
const replayAtFromHash = (hash = window.location.hash, now = new Date()) =>
  parseReplayAt(hashParams(hash).get('at') ?? undefined, now);

/** at 的规范化查询值：统一用 ISO，便于跨日复制深链接。 */
const replayParam = (at) => {
  if (at === null || at === undefined) return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** 追加到已有 GET 查询串的 at（无 at 时为空串）。 */
const replayQuerySuffix = (at) => {
  const param = replayParam(at);
  return param === null ? '' : `&at=${encodeURIComponent(param)}`;
};

/** 作为请求路径首个查询参数时的 at（无 at 时为空串）。 */
const replayQueryPrefix = (at) => {
  const param = replayParam(at);
  return param === null ? '' : `?at=${encodeURIComponent(param)}`;
};

/** 追加到 hash 查询串的 at（无 at 时为空串）。 */
const replayHashSuffix = (at) => {
  const param = replayParam(at);
  return param === null ? '' : `&at=${encodeURIComponent(param)}`;
};

/** 顶部回放条文案（按钮单独渲染「回到最新」）；最新模式返回 null。 */
const replayBannerText = (at) =>
  at === null || at === undefined ? null : `回放中 ${replayClockLabel(at)}`;

/**
 * 回放时点没有可用批次时的明确原因；最新模式返回 null。
 * 历史范围从最早可信采样起算，更早的时点只能回看，不补造数据。
 */
const replayEmptyNotice = (at) =>
  at === null || at === undefined
    ? null
    : `回放时点 ${replayClockLabel(at)} 及之前没有已发布的盘中批次（早于最早可信样本），该时点不可回放。`;

/** 去掉 hash 里的 at（「回到最新」），保留 tab / kind / sort / window / event 等其它参数。 */
const hashWithoutReplayAt = (hash = window.location.hash) => {
  const raw = String(hash ?? '').replace(/^#/, '');
  const separator = raw.indexOf('?');
  const route = separator === -1 ? raw : raw.slice(0, separator);
  const params = new URLSearchParams(separator === -1 ? '' : raw.slice(separator + 1));
  params.delete('at');
  const query = params.toString();
  const safeRoute = route === '' ? 'market-room' : route;
  return query === '' ? safeRoute : `${safeRoute}?${query}`;
};

export {
  hashWithoutReplayAt,
  parseReplayAt,
  replayAtFromHash,
  replayBannerText,
  replayClockLabel,
  replayEmptyNotice,
  replayHashSuffix,
  replayParam,
  replayQueryPrefix,
  replayQuerySuffix,
  shanghaiDate,
};
