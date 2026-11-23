import type { SectorQuoteSource } from '@luoome/core';

import {
  httpStatusErrorKind,
  invalidPayloadError,
  isAbortError,
  networkError,
  SourceExecutionError,
  timeoutError,
} from '../source-error.js';
import type { SectorQuoteAdapterLike, SectorQuoteRawItem } from './types.js';

/**
 * 新浪行业板块 adapter（免费备用源，无需 key）。
 *
 * 最终选用端点（2026-11-23 联网核实）：
 *   https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php
 * - 响应是 GBK 编码的 JS 赋值：`var S_Finance_bankuai_sinaindustry = {"new_blhy":"...", ...}`，
 *   取首个 `{` 到末个 `}` 做 JSON 解析；本适配器按 gbk 解码，与东财 UTF-8 JSON 不同
 * - 每个 value 是固定顺序的 CSV：板块代码,名称,成分股数,平均价,涨跌额,涨跌幅(%),
 *   成交量(股),成交额(元),领涨股代码(sz/sh 前缀),领涨股涨跌幅(%),领涨股价格,领涨股涨跌额,领涨股名称
 * - 没有涨跌家数字段：up_count / down_count 在边界内保持 undefined，不补 0
 * - 板块代码是 new_xxx，与东财 BKxxxx 不同体系；领涨股代码转成仓库 stockId（002623.SZ）
 * - 涨跌幅 / 领涨股涨跌幅归一为小数（/100）；成交额单位元不换算
 * - 上游不提供排序参数：按 fid 本地排序并截断，语义与东财上游降序一致
 */

const DEFAULT_URL = 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php';
const DEFAULT_TIMEOUT_MS = 10_000;
/** 新浪板块 CSV 至少要有到领涨股名称（下标 12）的 13 列。 */
const MIN_FIELDS = 13;

const asNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : undefined;
};

const asString = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

/** sz002623 / sh600769 → 002623.SZ / 600769.SH；无法识别时返回 undefined 不伪造代码。 */
const toStockId = (prefixed: string | undefined): string | undefined => {
  const [, exchange, code] = /^(sh|sz|bj)(\d{6})$/i.exec(asString(prefixed) ?? '') ?? [];
  return code === undefined || exchange === undefined
    ? undefined
    : `${code}.${exchange.toUpperCase()}`;
};

const parseItem = (row: string): SectorQuoteRawItem | undefined => {
  const fields = row.split(',');
  if (fields.length < MIN_FIELDS) return undefined;
  const code = asString(fields[0]);
  const name = asString(fields[1]);
  const price = asNumber(fields[3]);
  const changePct = asNumber(fields[5]);
  // 停牌 / 空行板块没有有效均价或涨跌幅，剔除而不是伪造 0
  if (code === undefined || name === undefined) return undefined;
  if (price === undefined || price <= 0 || changePct === undefined) return undefined;

  const leadingStockName = asString(fields[12]);
  const leadingStockCode = toStockId(fields[8]);
  const leadingStockChangePct = asNumber(fields[9]);
  return {
    code,
    name,
    price,
    change_pct: changePct / 100,
    change: asNumber(fields[4]) ?? 0,
    amount: asNumber(fields[7]) ?? 0,
    ...(leadingStockName === undefined ? {} : { leading_stock_name: leadingStockName }),
    ...(leadingStockCode === undefined ? {} : { leading_stock_code: leadingStockCode }),
    ...(leadingStockChangePct === undefined
      ? {}
      : { leading_stock_change_pct: leadingStockChangePct / 100 }),
  };
};

export class SinaSectorQuoteAdapter implements SectorQuoteAdapterLike {
  readonly name: SectorQuoteSource = 'sina';

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly url: string = DEFAULT_URL,
  ) {}

  async fetchList(
    pageSize: number | undefined,
    fid: 'f3' | 'f6',
  ): Promise<{ readonly items: SectorQuoteRawItem[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let body: string;
    try {
      const res = await this.fetchImpl(this.url, { signal: controller.signal });
      if (!res.ok) {
        throw new SourceExecutionError(
          httpStatusErrorKind(res.status),
          `sina sector-quote HTTP ${res.status}`,
        );
      }
      body = new TextDecoder('gbk' as never).decode(await res.arrayBuffer());
    } catch (error) {
      if (error instanceof SourceExecutionError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw isAbortError(error)
        ? timeoutError(`sina sector-quote 请求超时: ${message}`, error)
        : networkError(`sina sector-quote 请求失败: ${message}`, error);
    } finally {
      clearTimeout(timer);
    }

    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw invalidPayloadError('invalid_payload: sina sector-quote 响应缺少 JS 对象');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.slice(start, end + 1));
    } catch (error) {
      throw invalidPayloadError('invalid_payload: sina sector-quote 响应不是有效 JSON', error);
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw invalidPayloadError('invalid_payload: sina sector-quote 响应结构无效');
    }

    const items: SectorQuoteRawItem[] = [];
    for (const row of Object.values(payload as Record<string, unknown>)) {
      if (typeof row !== 'string') continue;
      const item = parseItem(row);
      if (item !== undefined) items.push(item);
    }
    items.sort((a, b) => (fid === 'f3' ? b.change_pct - a.change_pct : b.amount - a.amount));
    return { items: pageSize === undefined ? items : items.slice(0, pageSize) };
  }
}
