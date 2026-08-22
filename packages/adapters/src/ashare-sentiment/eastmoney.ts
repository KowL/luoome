import { asNonnegativeInt, asNonnegativeNumber, asPositiveInt } from '../eastmoney/coercion.js';
import type { AShareSentimentRawEntry } from './types.js';

/**
 * Eastmoney 情绪池（封板 getTopicZTPool / 炸板 getTopicZBPool）协议层（主源）。
 *
 * 本模块只保留 URL 模板与字段映射纯函数；HTTP 与错误归一由 eastmoney/client.ts +
 * eastmoney/source.ts 承担（docs/ddd/source-pluggability-and-observation-design.md §4.2/§4.3）。
 */

const SEALED_POOL_URL = 'https://push2ex.eastmoney.com/getTopicZTPool';
const BROKEN_POOL_URL = 'https://push2ex.eastmoney.com/getTopicZBPool';
const UT = '7eea3edcaed734bea9cbfc24409ed989';
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** 封板 / 炸板池 URL。 */
export const sentimentPoolUrl = (kind: 'sealed' | 'broken', date: string): string => {
  const ymd = date.replaceAll('-', '');
  const query = `ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=5000&sort=fbt:asc&date=${ymd}`;
  return `${kind === 'sealed' ? SEALED_POOL_URL : BROKEN_POOL_URL}?${query}`;
};

/** 炸板池只支持最近 30 天（含今天，Asia/Shanghai 口径）。 */
export const brokenPoolSupports = (date: string, now: Date): boolean => {
  const cutoff = new Date(now.getTime() + SHANGHAI_OFFSET_MS - THIRTY_DAYS_MS)
    .toISOString()
    .slice(0, 10);
  return date >= cutoff;
};

const exchangeFor = (code: string): 'SH' | 'SZ' | undefined => {
  if (/^(?:6|68)\d{5}$/.test(code)) return 'SH';
  if (/^(?:0|3)\d{5}$/.test(code)) return 'SZ';
  return undefined;
};

const ladderLevelFrom = (value: Record<string, unknown>): number => {
  const direct = asPositiveInt(value.lbc);
  if (direct !== undefined) return direct;
  const stat = value.zttj;
  if (typeof stat === 'object' && stat !== null) {
    const record = stat as Record<string, unknown>;
    return asPositiveInt(record.ct) ?? asPositiveInt(record.days) ?? 1;
  }
  if (typeof stat === 'string') {
    const match = stat.match(/(\d+)\s*板/);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return 1;
};

const parseEntry = (
  value: unknown,
  kind: 'sealed' | 'broken',
): AShareSentimentRawEntry | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.c !== 'string') return undefined;
  const exchange = exchangeFor(record.c);
  if (exchange === undefined) return undefined;
  const name =
    typeof record.n === 'string' && record.n.trim().length > 0 ? record.n.trim() : record.c;
  const industry =
    typeof record.hybk === 'string' && record.hybk.trim().length > 0
      ? record.hybk.trim()
      : undefined;
  return {
    stockId: `${record.c}.${exchange}`,
    name,
    ladderLevel: ladderLevelFrom(record),
    sealAmount: kind === 'sealed' ? asNonnegativeNumber(record.fund) : null,
    openCount: asNonnegativeInt(record.zbc),
    ...(industry === undefined ? {} : { industry }),
    concepts: [],
  };
};

/** 池响应 → 规范化条目；上游空池（data=null / pool 缺失）→ 空数组，不视为失败。 */
export const parseSentimentPool = (
  raw: unknown,
  kind: 'sealed' | 'broken',
): AShareSentimentRawEntry[] => {
  const data =
    typeof raw === 'object' && raw !== null
      ? ((raw as Record<string, unknown>).data as Record<string, unknown> | null | undefined)
      : undefined;
  const pool = Array.isArray(data?.pool) ? data.pool : [];
  return pool
    .map((item) => parseEntry(item, kind))
    .filter((entry): entry is AShareSentimentRawEntry => entry !== undefined);
};
