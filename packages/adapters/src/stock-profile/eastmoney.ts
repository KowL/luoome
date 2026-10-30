import { invalidPayloadError, upstreamError } from '../source-error.js';
import type { StockProfileRawConcept, StockProfileRawHolder } from './types.js';

/**
 * Eastmoney 个股档案协议层（股东户数 + 所属板块）。
 *
 * 与 dragon-tiger / northbound-flow 同族（datacenter-web 报表系），最终选用端点
 * （真实请求冒烟验证 2026-10-30）：
 *   股东户数  https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_HOLDERNUMLATEST
 *   所属板块  https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_CORETHEME_BOARDTYPE
 *
 * 股东户数报表达标语义：
 * - END_DATE 统计截止日（"2026-10-09 00:00:00"，取日期部分）
 * - HOLDER_NUM 股东户数；PRE_HOLDER_NUM 上期户数；HOLDER_NUM_CHANGE 变动户数
 * - HOLDER_NUM_RATIO 变动比例，上游是百分数（-1.84 = -1.84%），本模块除以 100 存小数
 * - AVG_HOLD_NUM 户均持股（股）；AVG_MARKET_CAP 户均市值（元）
 * - 报表只给最近一期，上期数据以 PRE_* 字段内联；本模块按上游原样透传，不外推历史
 *
 * 所属板块报表达标语义：
 * - BOARD_NAME 板块名；NEW_BOARD_CODE 板块代码（BK 前缀）
 * - BOARD_TYPE 板块类型，多数行未标注 → null（不从代码前缀猜类型）
 * - IS_PRECISE 是否精确归属（1/0）；BOARD_RANK 板块内排序
 * - SELECTED_BOARD_REASON 入选理由原文
 *
 * 本模块只保留 URL 模板与字段映射纯函数；HTTP 由 eastmoney/client.ts 承担。
 */

const BASE_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const HOLDER_REPORT = 'RPT_HOLDERNUMLATEST';
const BOARD_REPORT = 'RPT_F10_CORETHEME_BOARDTYPE';

/** 股票代码归一：300476.SZ → 300476（股东户数报表按裸代码过滤）。 */
export const bareStockCode = (stockId: string): string => stockId.split('.')[0] ?? stockId;

/** 股东户数报表 URL（取最近一期）。 */
export const stockProfileHolderUrl = (stockId: string): string => {
  const filter = encodeURIComponent(`(SECURITY_CODE="${bareStockCode(stockId)}")`);
  return (
    `${BASE_URL}?reportName=${HOLDER_REPORT}&columns=ALL&source=WEB&CLIENT=WEB` +
    `&sortColumns=END_DATE&sortTypes=-1&pageSize=1&pageNumber=1&filter=${filter}`
  );
};

/** 所属板块报表 URL。 */
export const stockProfileBoardUrl = (stockId: string): string => {
  const filter = encodeURIComponent(`(SECUCODE="${stockId}")`);
  return (
    `${BASE_URL}?reportName=${BOARD_REPORT}&columns=ALL&source=WEB&CLIENT=WEB` +
    `&pageSize=100&pageNumber=1&filter=${filter}`
  );
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** "2026-10-09 00:00:00" → "2026-10-09"；无法解析返回 null。 */
const asDate = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const date = /^(\d{4}-\d{2}-\d{2})(?:$|[ T])/.exec(value.trim())?.[1];
  if (date === undefined) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
    ? date
    : null;
};

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const optionalNonnegativeNumber = (value: unknown, field: string): number | null => {
  if (value === null || value === undefined) return null;
  const number = asNumber(value);
  if (number === null || number < 0) {
    throw invalidPayloadError(`eastmoney ${HOLDER_REPORT} ${field} 无效`);
  }
  return number;
};

/**
 * 报表响应 → 数据行数组。
 * 报表层业务错误抛 upstream_error；畸形信封或错股行抛 invalid_payload。
 * success=true 且 result=null 表示合法无数据。
 */
const reportRows = (
  raw: unknown,
  report: string,
  expectedStockId?: string,
): Record<string, unknown>[] => {
  const body = asRecord(raw);
  if (body?.success === false) {
    throw upstreamError(`eastmoney ${report} 报表错误: ${String(body.message)}`);
  }
  if (body?.success !== true) {
    throw invalidPayloadError(`eastmoney ${report} 报表信封无效`);
  }
  if (body.result === null) return [];
  const result = asRecord(body.result);
  const rows = result?.data;
  if (!Array.isArray(rows)) {
    throw invalidPayloadError(`eastmoney ${report} result.data 必须为数组`);
  }
  return rows.map((item) => {
    const row = asRecord(item);
    if (row === null) {
      throw invalidPayloadError(`eastmoney ${report} 数据行必须为对象`);
    }
    if (
      expectedStockId !== undefined &&
      ((row.SECUCODE != null && row.SECUCODE !== expectedStockId) ||
        (row.SECURITY_CODE != null && row.SECURITY_CODE !== bareStockCode(expectedStockId)))
    ) {
      throw invalidPayloadError(`eastmoney ${report} 数据行股票代码与请求不符`);
    }
    return row;
  });
};

/**
 * 股东户数行 → 协议层。
 * 统计截止日或户数无效时抛 invalid_payload；变动比例由百分数转小数。
 */
export const parseStockProfileHolder = (
  raw: unknown,
  expectedStockId?: string,
): StockProfileRawHolder | null => {
  const row = reportRows(raw, HOLDER_REPORT, expectedStockId)[0];
  if (row === undefined) return null;
  const endDate = asDate(row.END_DATE);
  const holderNum = asNumber(row.HOLDER_NUM);
  if (endDate === null) {
    throw invalidPayloadError(`eastmoney ${HOLDER_REPORT} END_DATE 无效`);
  }
  if (holderNum === null || !Number.isInteger(holderNum) || holderNum < 0) {
    throw invalidPayloadError(`eastmoney ${HOLDER_REPORT} HOLDER_NUM 必须为非负整数`);
  }
  const ratio = asNumber(row.HOLDER_NUM_RATIO);
  return {
    endDate,
    holderNum,
    changePct: ratio === null ? null : ratio / 100,
    avgShares: optionalNonnegativeNumber(row.AVG_HOLD_NUM, 'AVG_HOLD_NUM'),
    avgMarketValue: optionalNonnegativeNumber(row.AVG_MARKET_CAP, 'AVG_MARKET_CAP'),
  };
};

/**
 * 所属板块行 → 协议层列表。
 * 缺板块名或代码时抛 invalid_payload；BOARD_TYPE 未标注时为 null。
 */
export const parseStockProfileBoards = (
  raw: unknown,
  expectedStockId?: string,
): StockProfileRawConcept[] => {
  const rows = reportRows(raw, BOARD_REPORT, expectedStockId);
  const parsed: StockProfileRawConcept[] = [];
  for (const row of rows) {
    const name = typeof row.BOARD_NAME === 'string' ? row.BOARD_NAME.trim() : '';
    const code = typeof row.NEW_BOARD_CODE === 'string' ? row.NEW_BOARD_CODE.trim() : '';
    if (name === '' || code === '') {
      throw invalidPayloadError(`eastmoney ${BOARD_REPORT} BOARD_NAME 或 NEW_BOARD_CODE 无效`);
    }
    const boardType = typeof row.BOARD_TYPE === 'string' ? row.BOARD_TYPE.trim() : '';
    const reason =
      typeof row.SELECTED_BOARD_REASON === 'string' ? row.SELECTED_BOARD_REASON.trim() : '';
    parsed.push({
      code,
      name,
      boardType: boardType === '' ? null : boardType,
      precise: String(row.IS_PRECISE) === '1',
      rank: asNumber(row.BOARD_RANK),
      reason: reason === '' ? null : reason,
    });
  }
  return parsed;
};
