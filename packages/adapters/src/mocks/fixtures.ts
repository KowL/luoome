import {
  type Account,
  type Advice,
  type AdviceDecision,
  type AdviceHorizon,
  adviceExpiryDays,
  type Holding,
  type Money,
  money,
  quantity,
  STANDARD_DISCLAIMERS,
  type Stock,
  stockCode,
  type Trade,
} from '@luoome/core';

import { DEFAULT_MOCK_NOW, hashString, pickDeterministic } from '../internal/deterministic.js';

/**
 * Mock 数据 fixtures（MVP-TASK §2.5）。
 * 全部为编译期常量：同一进程 / 不同进程多次加载结果一致。
 * id 约定：Stock.id = `${code}.${exchange}`（如 '002594.SZ'）。
 */

// ---------- 股票：10 A 股 + 5 港股 + 5 美股 ----------

const stock = (
  code: string,
  exchange: Stock['exchange'],
  name: string,
  industry: string,
): Stock => ({
  id: `${code}.${exchange}`,
  code: stockCode(code),
  exchange,
  name,
  industry,
});

export const MOCK_STOCKS: readonly Stock[] = [
  // A 股 ×10
  stock('600519', 'SH', '贵州茅台', '白酒'),
  stock('300750', 'SZ', '宁德时代', '电池'),
  stock('002594', 'SZ', '比亚迪', '汽车整车'),
  stock('600036', 'SH', '招商银行', '银行'),
  stock('000858', 'SZ', '五粮液', '白酒'),
  stock('601318', 'SH', '中国平安', '保险'),
  stock('000063', 'SZ', '中兴通讯', '通信设备'),
  stock('688981', 'SH', '中芯国际', '半导体'),
  stock('600900', 'SH', '长江电力', '电力'),
  stock('002415', 'SZ', '海康威视', '计算机设备'),
  // 港股 ×5
  stock('00700', 'HK', '腾讯控股', '互联网'),
  stock('09988', 'HK', '阿里巴巴-W', '互联网'),
  stock('03690', 'HK', '美团-W', '互联网'),
  stock('01810', 'HK', '小米集团-W', '消费电子'),
  stock('00941', 'HK', '中国移动', '电信'),
  // 美股 ×5
  stock('AAPL', 'US', '苹果', '消费电子'),
  stock('MSFT', 'US', '微软', '软件'),
  stock('NVDA', 'US', '英伟达', '半导体'),
  stock('TSLA', 'US', '特斯拉', '汽车'),
  stock('BABA', 'US', '阿里巴巴', '互联网'),
];

/** 各 fixture 股票的 mock 基准价（close），供行情 adapter 与持仓成本对齐。 */
export const MOCK_STOCK_BASE_PRICES: Readonly<Record<string, Money>> = {
  '600519.SH': money(1486.2),
  '300750.SZ': money(268.5),
  '002594.SZ': money(105.8),
  '600036.SH': money(42.35),
  '000858.SZ': money(128.9),
  '601318.SH': money(55.6),
  '000063.SZ': money(42.1),
  '688981.SH': money(98.75),
  '600900.SH': money(28.4),
  '002415.SZ': money(33.25),
  '00700.HK': money(512.0),
  '09988.HK': money(118.5),
  '03690.HK': money(128.4),
  '01810.HK': money(56.8),
  '00941.HK': money(86.5),
  'AAPL.US': money(212.4),
  'MSFT.US': money(498.6),
  'NVDA.US': money(164.9),
  'TSLA.US': money(322.1),
  'BABA.US': money(117.3),
};

/** 按 Stock.id 或 Stock.code 查找 fixture 股票。 */
export const findMockStock = (stockIdOrCode: string): Stock | null => {
  const normalized = stockIdOrCode.trim().toUpperCase();
  for (const s of MOCK_STOCKS) {
    if (s.id.toUpperCase() === normalized || s.code === normalized) {
      return s;
    }
  }
  return null;
};

// ---------- 账户：1 个默认账户（uuid 固定） ----------

export const MOCK_ACCOUNT: Account = {
  id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  name: '默认模拟账户',
  kind: 'mock',
  currency: 'CNY',
  initialCapital: money(1000000),
  createdAt: new Date('2026-01-05T01:00:00.000Z'),
};

/** 长期持仓账户（W3 多账户切换演示）：初始资金 50 万，余额静置 */
export const MOCK_ACCOUNT_LONGTERM: Account = {
  id: 'a1b2c3d4-0001-4000-8000-000000000001',
  name: '长期持仓',
  kind: 'mock',
  currency: 'CNY',
  initialCapital: money(500_000),
  createdAt: new Date('2026-02-01T01:00:00.000Z'),
};

/** 短线交易账户（W3 多账户切换演示）：初始资金 20 万，余额静置 */
export const MOCK_ACCOUNT_SHORTTERM: Account = {
  id: 'a1b2c3d4-0001-4000-8000-000000000002',
  name: '短线交易',
  kind: 'mock',
  currency: 'CNY',
  initialCapital: money(200_000),
  createdAt: new Date('2026-03-01T01:00:00.000Z'),
};

/** 全部 mock 账户（默认账户 + 长期 + 短线），供 list_accounts / seed 使用。 */
export const MOCK_ACCOUNTS: readonly Account[] = [
  MOCK_ACCOUNT,
  MOCK_ACCOUNT_LONGTERM,
  MOCK_ACCOUNT_SHORTTERM,
];

// ---------- 持仓：6 个（引用 MOCK_STOCKS / MOCK_ACCOUNT） ----------

const holding = (
  id: string,
  stockId: string,
  qty: number,
  avgCost: number,
  openedAt: string,
): Holding => ({
  id,
  accountId: MOCK_ACCOUNT.id,
  stockId,
  quantity: qty,
  availableQuantity: qty,
  avgCost: money(avgCost),
  openedAt: new Date(openedAt),
  closedAt: null,
});

export const MOCK_HOLDINGS: readonly Holding[] = [
  holding('mock-holding-002594', '002594.SZ', 1000, 98.5, '2026-05-06T02:30:00.000Z'),
  holding('mock-holding-600519', '600519.SH', 100, 1450.0, '2026-04-15T02:30:00.000Z'),
  holding('mock-holding-00700', '00700.HK', 500, 480.0, '2026-03-20T02:30:00.000Z'),
  holding('mock-holding-aapl', 'AAPL.US', 50, 195.0, '2026-02-10T15:30:00.000Z'),
  holding('mock-holding-300750', '300750.SZ', 400, 250.0, '2026-05-28T02:30:00.000Z'),
  holding('mock-holding-600036', '600036.SH', 2000, 39.8, '2026-06-03T02:30:00.000Z'),
];

// ---------- 交易：与持仓一致（买入口径，数量/加权成本对齐） ----------

const trade = (
  id: string,
  stockId: string,
  qty: number,
  price: number,
  fee: number,
  executedAt: string,
): Trade => ({
  id,
  accountId: MOCK_ACCOUNT.id,
  stockId,
  side: 'buy',
  quantity: quantity(qty),
  price: money(price),
  fee: money(fee),
  executedAt: new Date(executedAt),
  source: 'manual',
  createdAt: new Date(executedAt),
});

export const MOCK_TRADES: readonly Trade[] = [
  // 002594.SZ：600 @96.00 + 400 @102.25 → 加权 98.50
  trade('mock-trade-0001', '002594.SZ', 600, 96.0, 14.4, '2026-05-06T02:30:00.000Z'),
  trade('mock-trade-0002', '002594.SZ', 400, 102.25, 10.23, '2026-05-06T06:30:00.000Z'),
  // 600519.SH：100 @1450.00
  trade('mock-trade-0003', '600519.SH', 100, 1450.0, 36.25, '2026-04-15T02:30:00.000Z'),
  // 00700.HK：300 @460.00 + 200 @510.00 → 加权 480.00
  trade('mock-trade-0004', '00700.HK', 300, 460.0, 27.6, '2026-03-20T02:30:00.000Z'),
  trade('mock-trade-0005', '00700.HK', 200, 510.0, 20.4, '2026-03-21T02:30:00.000Z'),
  // AAPL.US：50 @195.00
  trade('mock-trade-0006', 'AAPL.US', 50, 195.0, 1.95, '2026-02-10T15:30:00.000Z'),
  // 300750.SZ：200 @245.00 + 200 @255.00 → 加权 250.00
  trade('mock-trade-0007', '300750.SZ', 200, 245.0, 12.25, '2026-05-28T02:30:00.000Z'),
  trade('mock-trade-0008', '300750.SZ', 200, 255.0, 12.75, '2026-05-29T02:30:00.000Z'),
  // 600036.SH：2000 @39.80
  trade('mock-trade-0009', '600036.SH', 2000, 39.8, 19.9, '2026-06-03T02:30:00.000Z'),
];

// ---------- Advice fixture ----------

const ADVICE_DECISIONS: readonly AdviceDecision[] = ['buy', 'sell', 'hold', 'watch', 'avoid'];
// 只取非 intraday 的 horizon：intraday 有效期为 0，无法保证 validUntil > validFrom。
const ADVICE_HORIZONS: readonly AdviceHorizon[] = ['short', 'medium', 'long'];

/**
 * 生成指定标的的完整 Advice fixture（MVP-TASK §2.5 mock-llm）。
 * deterministic：同一 stockId + 同一 clock 永远得到同一结果；
 * 必含 3 条 STANDARD_DISCLAIMERS、validUntil > validFrom，可过 assertAdviceInvariants。
 */
export const mockAdviceFor = (
  stockId: string,
  clock: () => Date = () => new Date(DEFAULT_MOCK_NOW.getTime()),
): Advice => {
  const now = clock();
  const seed = hashString(`advice|${stockId}`);
  const decision = pickDeterministic(ADVICE_DECISIONS, seed);
  const horizon = pickDeterministic(ADVICE_HORIZONS, hashString(`horizon|${stockId}`));
  const confidence = 45 + (seed % 50); // 45-94
  const validFrom = new Date(now.getTime());
  const validUntil = new Date(now.getTime() + adviceExpiryDays[horizon] * 86_400_000);
  const known = findMockStock(stockId);
  const resolvedStockId = known ? known.id : stockId;

  return {
    id: `mock-advice-${seed.toString(16).padStart(8, '0')}`,
    subjectKind: 'stock',
    subjectId: resolvedStockId,
    decision,
    confidence,
    horizon,
    reasoning: {
      premise: `mock 分析：${resolvedStockId} 当前信号指向「${decision}」（确定性 fixture）。`,
      evidence: [
        `mock 证据：${resolvedStockId} 基准价与 60 日线偏离处于历史中枢`,
        'mock 证据：近 20 日量能温和，未出现异常放量',
      ],
      counterEvidence: ['mock 反证：板块轮动与大盘系统性风险未纳入 mock 模型'],
    },
    risks: ['mock 风险：本 fixture 不反映真实基本面', 'mock 风险：大盘系统性下行风险'],
    disclaimers: [...STANDARD_DISCLAIMERS],
    sourceTool: 'analyze_stock',
    basedOn: { dataAsOf: validFrom },
    validFrom,
    validUntil,
    createdAt: validFrom,
  };
};
