import type { SectorQuoteAdapterLike, SectorQuoteRawItem } from './types.js';

/**
 * Eastmoney 行业板块行情 adapter（主源）。
 *
 * 最终选用端点（真实请求冒烟验证 2026-08-22）：
 *   https://push2delay.eastmoney.com/api/qt/clist/get
 *   ?pn=1&pz=N&po=1&np=1&fltt=2&invt=2&fid=<f3|f6>&fs=m:90+t:2
 *   &fields=f12,f14,f2,f3,f4,f6,f104,f105,f124,f128,f136,f140&ut=<公开 token>
 * - fs=m:90+t:2 为行业板块集合（与参考产品 finance-workbench realtime.ts 一致）
 * - 默认走 push2delay：主域 push2.eastmoney.com 的 clist/get 在本机实测整批断连
 *   （ECONNRESET，同 host 的 kamt 接口正常），push2delay 字段与响应结构相同；
 *   可用 baseUrl 覆盖回主域
 * - 响应 data.diff 行字段（冒烟验证）：f12 代码(BKxxxx) / f14 名称 / f2 最新价 /
 *   f3 涨跌幅(百分数) / f4 涨跌额 / f6 成交额(元) / f104 上涨家数 / f105 下跌家数 /
 *   f128 领涨股名称 / f140 领涨股代码 / f136 领涨股涨跌幅(百分数) / f124 行情时间戳
 * - 涨跌幅在 adapter 边界归一为小数（/100），成交额单位元不换算
 */

const DEFAULT_BASE_URL = 'https://push2delay.eastmoney.com/api/qt/clist/get';
const SECTOR_FS = 'm:90+t:2';
const FIELDS = 'f12,f14,f2,f3,f4,f6,f104,f105,f124,f128,f136,f140';
const UT_TOKEN = 'bd1d9ddb04089700cf9c27f6f7426281';
const DEFAULT_TIMEOUT_MS = 10_000;

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v : undefined;

export class EastmoneySectorQuoteAdapter implements SectorQuoteAdapterLike {
  readonly name = 'eastmoney' as const;

  constructor(
    private readonly fetchImpl?: typeof fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async fetchList(
    pageSize: number,
    fid: 'f3' | 'f6',
  ): Promise<{ readonly items: SectorQuoteRawItem[] }> {
    const url =
      `${this.baseUrl}?pn=1&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=${fid}` +
      `&fs=${encodeURIComponent(SECTOR_FS)}&fields=${FIELDS}&ut=${UT_TOKEN}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await (this.fetchImpl ?? fetch)(url, { signal: controller.signal });
    } catch (error) {
      throw new Error(
        `eastmoney sector-quote 请求失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`eastmoney sector-quote HTTP ${res.status}`);

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (error) {
      throw new Error(`eastmoney sector-quote 响应不是有效 JSON: ${String(error)}`);
    }
    const body = raw as Record<string, unknown>;
    const data = body.data as Record<string, unknown> | null | undefined;
    // 无数据时 data 为 null（非业务错误），按空列表处理
    const rows = Array.isArray(data?.diff) ? (data.diff as unknown[]) : [];

    const items: SectorQuoteRawItem[] = [];
    for (const item of rows) {
      const obj = item as Record<string, unknown>;
      const code = asString(obj.f12);
      const name = asString(obj.f14);
      const price = asNumber(obj.f2);
      const changePct = asNumber(obj.f3);
      if (code === undefined || name === undefined) continue;
      if (price === undefined || price <= 0 || changePct === undefined) continue;
      const upCount = asNumber(obj.f104);
      const downCount = asNumber(obj.f105);
      const leadingStockName = asString(obj.f128);
      const leadingStockCode = asString(obj.f140);
      const leadingStockChangePct = asNumber(obj.f136);
      items.push({
        code,
        name,
        price,
        change_pct: changePct / 100,
        change: asNumber(obj.f4) ?? 0,
        amount: asNumber(obj.f6) ?? 0,
        ...(upCount === undefined ? {} : { up_count: upCount }),
        ...(downCount === undefined ? {} : { down_count: downCount }),
        ...(leadingStockName === undefined ? {} : { leading_stock_name: leadingStockName }),
        ...(leadingStockCode === undefined ? {} : { leading_stock_code: leadingStockCode }),
        ...(leadingStockChangePct === undefined
          ? {}
          : { leading_stock_change_pct: leadingStockChangePct / 100 }),
      });
    }
    return { items };
  }
}
