/**
 * luoome watch —— 纯函数 / 可单测逻辑（packages/cli/src/watch.ts）。
 *
 * 设计：
 * - isTradingHours / nextRunAt / formatTriggerLog 都是纯函数，便于单测
 * - runWatchLoop（在 index.ts 内）负责 IO + 循环 + SIGINT
 */

import type { Quote } from '@luoome/core';

import {
  BUILTIN_HOLIDAYS,
  type Holiday,
  isHoliday as isHolidayByCalendar,
  mergeHolidayCalendars,
  parseEnvHolidays,
} from './holidays.js';

/** Asia/Shanghai 时区偏移（+8h，无夏令时）；避免依赖 process.env.TZ / 容器时区漂移。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 把 date 转成 Asia/Shanghai 当日的 wall-clock 数字（小时/分钟/星期）。 */
const shanghaiParts = (date: Date): { hour: number; minute: number; weekday: number } => {
  const utcMs = date.getTime();
  const shMs = (utcMs + SHANGHAI_OFFSET_MS) % (24 * 60 * 60 * 1000);
  const hour = Math.floor(shMs / (60 * 60 * 1000));
  const minute = Math.floor((shMs % (60 * 60 * 1000)) / (60 * 1000));
  // weekday 取 UTC weekday + 偏移（Shanghai = UTC+8，跨日时 weekday 也跟着滚）
  const shanghaiDate = new Date(utcMs + SHANGHAI_OFFSET_MS);
  const weekday = shanghaiDate.getUTCDay();
  return { hour, minute, weekday };
};

/**
 * 把环境变量 `LUOOME_A_SHARE_HOLIDAYS` 与内置节假日历合并。
 * 默认懒加载一次（模块级缓存），避免每次 isTradingHours 都解析。
 */
let cachedCalendar: ReadonlyMap<number, ReadonlySet<Holiday>> | undefined;
const getCalendar = (): ReadonlyMap<number, ReadonlySet<Holiday>> => {
  if (cachedCalendar === undefined) {
    cachedCalendar = mergeHolidayCalendars(
      BUILTIN_HOLIDAYS,
      parseEnvHolidays(process.env.LUOOME_A_SHARE_HOLIDAYS),
    );
  }
  return cachedCalendar;
};

/** 仅供单测 / 维护工具使用：重置节假日历缓存（让 env 变更生效）。 */
export const _resetHolidayCache = (): void => {
  cachedCalendar = undefined;
};

/**
 * A 股盘中时段判断（北京时间 9:30–11:30 / 13:00–15:00，周一至周五）。
 *
 * v0.6 起加入节假日历（默认含 2026 全年；可通过 `LUOOME_A_SHARE_HOLIDAYS` 追加）：
 * - 周末 → 非交易
 * - 节假日（yyyy-MM-dd in Shanghai）→ 非交易
 * - 工作日 → 看 9:30–11:30 / 13:00–15:00 时段
 *
 * 不识别「调休补班」—— A 股惯例是把假期调成连续工作日，倒过来不需要补班日。
 */
export const isTradingHours = (
  date: Date,
  holidays?: ReadonlyMap<number, ReadonlySet<Holiday>>,
): boolean => {
  const cal = holidays ?? getCalendar();
  if (isHolidayByCalendar(date, cal)) return false;
  const { hour, minute, weekday } = shanghaiParts(date);
  if (weekday === 0 || weekday === 6) return false; // 周日 / 周六
  const t = hour * 60 + minute;
  const morning = 9 * 60 + 30 <= t && t <= 11 * 60 + 30;
  const afternoon = 13 * 60 <= t && t <= 15 * 60;
  return morning || afternoon;
};

/**
 * 算下一次执行时刻：
 * - 盘内 → intervalMs 后
 * - 盘外（收盘后或非交易日）→ 下一交易日 9:30 减 60s 缓冲
 *
 * v1 简化：盘外一律等 60s 重试；CLI 的 runWatchLoop 主循环在调用方再做轻量 sleep。
 */
export const nextRunDelayMs = (
  now: Date,
  intervalMs: number,
  tradingHoursChecker: (d: Date) => boolean = isTradingHours,
): number => {
  if (tradingHoursChecker(now)) return Math.max(intervalMs, 60_000); // 盘内：至少 60s
  return 60_000; // 盘外：60s 重试
};

/** intervalMs 下限 clamp 到 60s（quote 缓存 TTL 60s；< 60s 拿到的会是缓存数据）。 */
export const clampInterval = (intervalMs: number): number => Math.max(intervalMs, 60_000);

/** 终端表格：触发列表。CJK 宽字符对齐。 */
const isWideCodePoint = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x20000 && code <= 0x3fffd);

const displayWidth = (s: string): number => {
  let width = 0;
  for (const ch of s) width += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return width;
};

const pad = (s: string, width: number): string => {
  const d = width - displayWidth(s);
  return d > 0 ? s + ' '.repeat(d) : s;
};

export interface FormatTriggerLogOptions {
  readonly suppressedLabel?: string;
}

/**
 * 触发日志行输入：兼容两种形态
 * - 完整 WatchTrigger（含 quote.close）
 * - workflow output 的 WatchTriggerSummary（含 quoteClose 字段）
 * 通过 'quoteClose' in t 做运行时判别；类型上是个松散结构（必填字段都列，quoteClose 可选）。
 */
export interface WatchTriggerLogInput {
  readonly poolId: string;
  readonly stockId: string;
  readonly ruleKind: string;
  readonly direction: string;
  readonly reason: string;
  readonly quoteClose?: number;
  readonly quote?: { readonly close: number; readonly ts: Date };
  readonly notified: boolean;
  readonly createdAt: Date;
}

export const formatTriggersForLog = (
  triggers: readonly WatchTriggerLogInput[],
  opts: FormatTriggerLogOptions = {},
): string => {
  const suppressedLabel = opts.suppressedLabel ?? '[cool]';
  if (triggers.length === 0) return '（无触发）';
  const lines: string[] = [
    `${pad('时间', 19)}  ${pad('池', 24)}  ${pad('股票', 12)}  ${pad('规则', 14)}  ${pad('方向', 6)}  现价    理由`,
  ];
  for (const t of triggers) {
    const time = t.createdAt.toISOString().slice(11, 19);
    const dir = t.notified
      ? t.direction === 'buy'
        ? '买'
        : t.direction === 'sell'
          ? '卖'
          : '观察'
      : suppressedLabel;
    const close = typeof t.quoteClose === 'number' ? t.quoteClose : (t.quote?.close ?? 0);
    lines.push(
      `${pad(time, 19)}  ${pad(t.poolId, 24)}  ${pad(t.stockId, 12)}  ${pad(t.ruleKind, 14)}  ${pad(dir, 6)}  ${close.toFixed(2).padStart(6)}    ${t.reason}`,
    );
  }
  return lines.join('\n');
};

/** quote 简表（终端 debug）。 */
export const formatQuoteForLog = (q: Quote): string =>
  `${q.stockId} close=${q.close.toFixed(2)} ts=${q.ts.toISOString()}`;
