import { type MarketSnapshot, type MarketSnapshotItem, MarketSnapshotSchema } from '@luoome/core';

import { FakeMarketAdapter } from './fake-market.js';
import { TEST_STOCK_BASE_PRICES, TEST_STOCKS } from './fixtures.js';

/**
 * 可重复输入的交易日夹具（ticket #35）：同一天六个模拟时点的沪深全市场快照。
 *
 * - 所有数值由显式公式从固定输入推出，不读 Date.now / Math.random，多次运行结果一致；
 * - 时点间隔只服务于演示，不代表生产采样窗口或真实成交时刻；
 * - 早盘三个时点由少数权重股领涨，后三个时点涨幅与成交额向其余成员扩散，
 *   供后续题材轮动 / 扩散 / 换位规则复用；
 * - 只覆盖沪深 A 股，与批次 coverage 一致。
 */

export const MARKET_DAY_TRADING_DATE = '2026-09-28';

export interface MarketDayPoint {
  /** 人类可读的时点说明。 */
  readonly label: string;
  /** Asia/Shanghai 的模拟时点。 */
  readonly at: Date;
}

const point = (time: string, label: string): MarketDayPoint => ({
  label,
  at: new Date(`${MARKET_DAY_TRADING_DATE}T${time}+08:00`),
});

export const MARKET_DAY_POINTS: readonly MarketDayPoint[] = [
  point('09:35', '开盘后'),
  point('10:15', '早盘分化'),
  point('11:00', '上午收盘前'),
  point('13:15', '午后开局'),
  point('14:15', '尾盘前'),
  point('14:50', '收盘前'),
];

export const MARKET_DAY_SOURCE = 'market-day-fixture';

const A_SHARE_STOCKS = TEST_STOCKS.filter(
  (stock) => stock.exchange === 'SH' || stock.exchange === 'SZ',
);

/** 累计成交进度（演示值）：金额随时点单调递增。 */
const AMOUNT_PROGRESS: readonly number[] = [0.14, 0.31, 0.48, 0.63, 0.84, 0.97];

/** 领涨组：前三个时点涨幅领先，随后回落；其余成员后段接力。 */
const LEADER_GROUP_SIZE = 3;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const pointProgress = (pointIndex: number): number => {
  const progress = pointIndex / (MARKET_DAY_POINTS.length - 1);
  return round2(progress * 10000) / 10000;
};

const changePctFor = (stockIndex: number, pointIndex: number): number => {
  const progress = pointProgress(pointIndex);
  if (stockIndex < LEADER_GROUP_SIZE) {
    return round2(3.4 - 2.4 * progress + ((stockIndex * 7) % 5) * 0.1);
  }
  const pace = 0.6 + ((stockIndex * 3) % 4) * 0.12;
  return round2(-0.2 + 3.2 * progress * pace);
};

const amountFor = (stockIndex: number, pointIndex: number): number => {
  const progress = AMOUNT_PROGRESS[pointIndex] ?? AMOUNT_PROGRESS.at(-1) ?? 0;
  const base = 2e8 + ((stockIndex * 137) % 9) * 1.2e8;
  const emphasis =
    stockIndex < LEADER_GROUP_SIZE ? 1 + 0.35 * (1 - pointIndex / 5) : 1 + 0.25 * (pointIndex / 5);
  return Math.round(base * progress * emphasis);
};

const prevCloseOf = (stockId: string): number => {
  const base = TEST_STOCK_BASE_PRICES[stockId];
  if (base === undefined) throw new Error(`market-day fixture 缺少基准价: ${stockId}`);
  return base;
};

export const marketDayItems = (pointIndex: number): readonly MarketSnapshotItem[] => {
  const pointValue = MARKET_DAY_POINTS[pointIndex];
  if (pointValue === undefined) {
    throw new Error(`market-day fixture 时点越界: ${pointIndex}`);
  }
  return A_SHARE_STOCKS.map((stock, stockIndex) => {
    const changePct = changePctFor(stockIndex, pointIndex);
    const close = round2(prevCloseOf(stock.id) * (1 + changePct / 100));
    return {
      id: stock.id,
      code: stock.code,
      exchange: stock.exchange,
      name: stock.name,
      close,
      changePct,
      amount: amountFor(stockIndex, pointIndex),
    };
  });
};

/** 某个模拟时点的确定性全市场快照；抓取时间取该时点本身。 */
export const marketDaySnapshot = (pointIndex: number): MarketSnapshot => {
  const pointValue = MARKET_DAY_POINTS[pointIndex];
  if (pointValue === undefined) {
    throw new Error(`market-day fixture 时点越界: ${pointIndex}`);
  }
  const items = marketDayItems(pointIndex);
  return MarketSnapshotSchema.parse({
    coverage: 'CN_A_SHARES_SH_SZ',
    source: MARKET_DAY_SOURCE,
    fetchedAt: pointValue.at,
    observedAt: pointValue.at,
    dataAsOf: pointValue.at,
    items,
    completeness: {
      expectedCount: items.length,
      receivedCount: items.length,
      missingCount: 0,
      duplicateCount: 0,
      complete: true,
    },
  });
};

/** 时钟对应的最近模拟时点；早于首个时点时拒绝，避免用未来数据冒充演示输入。 */
export const marketDayPointFor = (at: Date): MarketDayPoint => {
  const pointValue = [...MARKET_DAY_POINTS]
    .reverse()
    .find((candidate) => at.getTime() >= candidate.at.getTime());
  if (pointValue === undefined) {
    throw new Error(
      `market-day fixture 不覆盖早于 ${MARKET_DAY_POINTS[0]?.at.toISOString()} 的时点`,
    );
  }
  return pointValue;
};

/**
 * 用可控时钟驱动的演示数据源：clock 落在哪个模拟时点，就返回该时点的快照。
 * `envelopeCalls` 供测试断言读取路径不触发重复采集。
 */
export class MarketDayFixtureAdapter extends FakeMarketAdapter {
  private readonly fixtureClock: () => Date;
  envelopeCalls = 0;

  constructor(options: { readonly clock: () => Date }) {
    super({ clock: options.clock });
    this.fixtureClock = options.clock;
  }

  override fetchMarketSnapshot(): Promise<readonly MarketSnapshotItem[]> {
    return this.fetchMarketSnapshotEnvelope().then((snapshot) => snapshot.items);
  }

  override fetchMarketSnapshotEnvelope(): Promise<MarketSnapshot> {
    this.envelopeCalls += 1;
    const selected = marketDayPointFor(this.fixtureClock());
    const pointIndex = MARKET_DAY_POINTS.findIndex((candidate) => candidate.at === selected.at);
    return Promise.resolve(marketDaySnapshot(pointIndex));
  }
}
