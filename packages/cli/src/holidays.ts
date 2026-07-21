/**
 * A 股节假日历（v0.6 起，docs/intraday-watch-design.md "已知边界"）。
 *
 * 设计要点：
 * - 默认硬编码 2026 全年节假日（YYYY-MM-DD 字符串，Asia/Shanghai 时区日期）
 * - 数据来源参考国办院年度放假通知（v0.6.0 固化）；每年 12 月国办发布次年通知后更新
 * - 通过 `LUOOME_A_SHARE_HOLIDAYS` 环境变量追加 / 覆盖（逗号分隔 YYYY-MM-DD）
 * - 不识别「调休补班」—— A 股惯例是把假期调成连续工作日，倒过来不需要补班日期
 *
 * ⚠️ 数据准确性声明：内置数据为参考值，每年需按国务院办公厅通知手工更新；
 *    真实交易请以交易所公告（http://www.sse.com.cn/）为准。
 */

export type Holiday = string; // 'YYYY-MM-DD' (Asia/Shanghai local date)

/** 2026 年 A 股休市日（沪深北全市场）。 */
export const CN_A_SHARE_HOLIDAYS_2026: ReadonlySet<Holiday> = new Set<Holiday>([
  // 元旦
  '2026-01-01',
  '2026-01-02',
  '2026-01-03',
  // 春节（除夕至初六）
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-02-19',
  '2026-02-20',
  '2026-02-21',
  '2026-02-22',
  // 清明
  '2026-04-04',
  '2026-04-05',
  '2026-04-06',
  // 五一劳动节
  '2026-05-01',
  '2026-05-02',
  '2026-05-03',
  // 端午
  '2026-06-19',
  '2026-06-20',
  '2026-06-21',
  // 中秋
  '2026-09-25',
  '2026-09-26',
  '2026-09-27',
  // 国庆
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
]);

/**
 * 内置节假日历（按年份分桶；新增年份时在此追加）。
 * v0.6 仅含 2026；2027+ 由维护者按国办通知补全。
 */
export const BUILTIN_HOLIDAYS: ReadonlyMap<number, ReadonlySet<Holiday>> = new Map([
  [2026, CN_A_SHARE_HOLIDAYS_2026],
]);

/**
 * Asia/Shanghai 时区偏移（毫秒）。
 * 不依赖 process.env.TZ / 容器时区——A 股规则严格按北京时间。
 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 把 Date 转换成 Asia/Shanghai 当日的 YYYY-MM-DD 字符串。
 * 用于与节假日历的字符串键比较。
 */
export const dateInShanghai = (date: Date): Holiday => {
  const shanghaiMs = date.getTime() + SHANGHAI_OFFSET_MS;
  const d = new Date(shanghaiMs);
  // 用 UTC 字段读（已经偏移过 ms）
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** 在节假日历（含跨年查找）中查找某日是否休市。 */
export const isHoliday = (
  date: Date,
  holidays: ReadonlyMap<number, ReadonlySet<Holiday>> = BUILTIN_HOLIDAYS,
): boolean => {
  const dateStr = dateInShanghai(date);
  const year = Number(dateStr.slice(0, 4));
  return holidays.get(year)?.has(dateStr) === true;
};

/** 是否周末（Asia/Shanghai 时区下的 weekday）。 */
export const isWeekend = (date: Date): boolean => {
  const shanghaiMs = date.getTime() + SHANGHAI_OFFSET_MS;
  const d = new Date(shanghaiMs);
  const wd = d.getUTCDay();
  return wd === 0 || wd === 6;
};

/**
 * 解析 `LUOOME_A_SHARE_HOLIDAYS` 环境变量。
 * 格式：逗号分隔 YYYY-MM-DD 字符串；空 / undefined 返回空 Map。
 * 用途：用户补全特定年份的休市日（如 2027+），覆盖内置数据。
 */
export const parseEnvHolidays = (
  raw: string | undefined,
): ReadonlyMap<number, ReadonlySet<Holiday>> => {
  if (raw === undefined || raw.trim() === '') return new Map();
  const out = new Map<number, Set<Holiday>>();
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) continue;
    const year = Number(trimmed.slice(0, 4));
    const set = out.get(year) ?? new Set<Holiday>();
    set.add(trimmed);
    out.set(year, set);
  }
  const readonly = new Map<number, ReadonlySet<Holiday>>();
  for (const [k, v] of out.entries()) readonly.set(k, v);
  return readonly;
};

/**
 * 合并多份节假日历：后者覆盖前者同名年份。空 Map 视为无操作。
 */
export const mergeHolidayCalendars = (
  ...calendars: ReadonlyMap<number, ReadonlySet<Holiday>>[]
): ReadonlyMap<number, ReadonlySet<Holiday>> => {
  const out = new Map<number, ReadonlySet<Holiday>>();
  for (const cal of calendars) {
    for (const [year, set] of cal.entries()) {
      const merged = new Set<Holiday>([...(out.get(year) ?? []), ...set]);
      out.set(year, merged);
    }
  }
  return out;
};
