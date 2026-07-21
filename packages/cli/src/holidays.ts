/**
 * A 股节假日历（v0.6 起，docs/intraday-watch-design.md "已知边界"）。
 *
 * 设计要点（v0.7 起补充文件加载）：
 * - 默认硬编码 2026 / 2027 全年节假日（YYYY-MM-DD 字符串，Asia/Shanghai 时区日期）
 * - 数据来源参考国务院年度放假通知；每年 12 月国办发布次年通知后由维护者手工更新
 * - 通过 `LUOOME_A_SHARE_HOLIDAYS` 环境变量追加 / 覆盖（逗号分隔 YYYY-MM-DD）
 * - 通过 `~/.luoome/holidays.json` 或 `LUOOME_HOLIDAYS_FILE` 指向的文件加载（v0.7+）
 * - 加载优先级：env > 文件 > 内置（merge 都以 union 方式叠加同一年份）
 * - 不识别「调休补班」—— A 股惯例是把假期调成连续工作日，倒过来不需要补班日期
 *
 * ⚠️ 数据准确性声明：内置数据为参考值，每年需按国务院办公厅通知手工更新；
 *    真实交易请以交易所公告（http://www.sse.com.cn/）为准。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * 2027 年 A 股休市日（v0.7 起，best-effort placeholder）。
 *
 * ⚠️ PLACEHOLDER：本数据按近 5 年（2022–2026）规律延伸得出，**尚未对照**
 *    国务院办公厅 2026 年 12 月发布的 2027 年度放假通知。每年 12 月通知发布后
 *    由维护者手工更新本常量。
 *
 * 真实休市日以政府通知（http://www.gov.cn/zhengce/）+ 沪深北交易所公告为准。
 * 用户若要提前 / 自定义补全：通过 ~/.luoome/holidays.json 或
 * `LUOOME_A_SHARE_HOLIDAYS` env 追加即可，无需等待新版本发布。
 *
 * ⚠️ 显式未列项：
 * - 2027 中秋（农历八月十五 ≈ 公历 2027-09-XX）—— 该日未对照国办通知，仅作占位。
 * - 五一调休边界（2027-04-30 等）—— 与近 5 年惯例未必完全一致。
 */
export const CN_A_SHARE_HOLIDAYS_2027: ReadonlySet<Holiday> = new Set<Holiday>([
  // 元旦（法定 1 天 — 2027-01-01 周五）
  '2027-01-01',
  // 春节（除夕至初六，7 个日历日，按 2022–2026 惯例推断）
  //   2027 除夕 = 农历腊月三十 = 公历 2027-02-06 (周六)
  '2027-02-06',
  '2027-02-07',
  '2027-02-08',
  '2027-02-09',
  '2027-02-10',
  '2027-02-11',
  '2027-02-12',
  // 清明（法定 1 天 — 2027-04-05 周一）
  '2027-04-05',
  // 五一劳动节（法定 1 天 + 调休凑 3 天连休，按 2026 惯例）
  '2027-05-01',
  '2027-05-02',
  '2027-05-03',
  // 端午（法定 1 天 — 农历五月初五 = 公历 2027-06-09 周三）
  '2027-06-09',
  // 国庆（法定 3 天 + 调休凑 7 天连休，按 2026 惯例）
  '2027-10-01',
  '2027-10-02',
  '2027-10-03',
  '2027-10-04',
  '2027-10-05',
  '2027-10-06',
  '2027-10-07',
]);

/**
 * 内置节假日历（按年份分桶；新增年份时在此追加）。
 * v0.6 含 2026；v0.7 新增 2027 best-effort placeholder。
 */
export const BUILTIN_HOLIDAYS: ReadonlyMap<number, ReadonlySet<Holiday>> = new Map<
  number,
  ReadonlySet<Holiday>
>([
  [2026, CN_A_SHARE_HOLIDAYS_2026],
  [2027, CN_A_SHARE_HOLIDAYS_2027],
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
 * 合并多份节假日历：后续 map 的同名年份做 union。空 Map 视为无操作。
 *
 * 注意：因为是 union（不是覆盖），通过 env / 文件追加条目不会丢失内置项，
 * 同一个来源提供同名日期也是幂等的（Set 去重）。
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

/**
 * 解析节假日历 JSON 对象（已通过 JSON.parse 反序列化的 `unknown`）。
 *
 * 期望格式：`{ "YYYY": ["YYYY-MM-DD", ...], ... }`
 * - 非 object / null → 空 Map
 * - key 不符合 4 位年份 → 该 key 跳过
 * - value 不是 string[] → 该 key 跳过
 * - string 元素不符合 YYYY-MM-DD 格式 → 跳过该元素
 * - string 元素的年份与 key 不一致 → 跳过该元素（防止跨年错位）
 *
 * 静默跳过：errors 不抛，因为 hot path 上文件损坏应被视作"无新数据"。
 */
export const parseHolidayObject = (raw: unknown): ReadonlyMap<number, ReadonlySet<Holiday>> => {
  if (typeof raw !== 'object' || raw === null) return new Map();
  const obj = raw as Record<string, unknown>;
  const out = new Map<number, Set<Holiday>>();
  for (const [yearKey, value] of Object.entries(obj)) {
    if (!/^\d{4}$/.test(yearKey)) continue;
    const year = Number(yearKey);
    if (!Array.isArray(value)) continue;
    let set: Set<Holiday> | undefined;
    for (const item of value) {
      if (typeof item !== 'string') continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item)) continue;
      const itemYear = Number(item.slice(0, 4));
      if (itemYear !== year) continue;
      // 月份范围二次校验：形式合法但语义非法（2026-13-01）应被拒绝。
      // 不校验具体 day 范围（闰年 / 月份最大日数较复杂），交给调用方兜底。
      const month = Number(item.slice(5, 7));
      if (month < 1 || month > 12) continue;
      set ??= out.get(year) ?? new Set<Holiday>();
      set.add(item);
    }
    if (set !== undefined && set.size > 0) out.set(year, set);
  }
  return out;
};

/**
 * 从指定文件加载节假日历（v0.7 起）。
 *
 * 文件格式：`{ "YYYY": ["YYYY-MM-DD", ...] }` （JSON）
 *
 * 容错策略：
 * - 文件不存在 → 空 Map（静默）
 * - 文件存在但 JSON.parse 失败 / 解析出非 object → 空 Map（静默）
 * - 任何 throws（EACCES 等）被 catch 住 → 空 Map
 *
 * 设计取舍：errors 不抛，因为 hot path 上一旦文件损坏就让 watch daemon crash
 * 是不值得的；用户能通过 `isHoliday` 看到 false 反推出文件被忽略。
 * 失败信号可通过 `LUOOME_LOG=debug` 日志（v0.7+ 计划）发现。
 */
export const loadHolidaysFromFile = (
  filePath: string,
): ReadonlyMap<number, ReadonlySet<Holiday>> => {
  try {
    if (!existsSync(filePath)) return new Map();
    const raw = readFileSync(filePath, 'utf8');
    return parseHolidayObject(JSON.parse(raw));
  } catch {
    return new Map();
  }
};

/**
 * 默认节假日历文件路径：`<homeDir>/holidays.json`。
 * 调用方负责传入 `homeDir`（如 LUOOME_HOME 默认值），避免本模块依赖环境变量。
 */
export const defaultHolidaysFilePath = (homeDir: string): string => join(homeDir, 'holidays.json');
