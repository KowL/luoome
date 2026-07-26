/**
 * A 股节假日历（IO 部分，v0.6 起，docs/ddd/intraday-watch-design.md "已知边界"）。
 *
 * 纯计算部分（内置数据 / dateInShanghai / isHoliday / isWeekend / merge 等）
 * 已下沉到 @luoome/core 的 trading-calendar（供 tools 复用），此处 re-export
 * 保持既有调用方不变；本文件只保留文件系统相关加载。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Holiday, parseHolidayObject } from '@luoome/core';

export {
  BUILTIN_HOLIDAYS,
  CN_A_SHARE_HOLIDAYS_2026,
  CN_A_SHARE_HOLIDAYS_2027,
  dateInShanghai,
  type Holiday,
  isHoliday,
  isWeekend,
  mergeHolidayCalendars,
  parseEnvHolidays,
  parseHolidayObject,
} from '@luoome/core';

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
