// T19 / REQ-M3-13 验收：IC / RankIC 计算层。
import { describe, expect, it } from 'vitest';
import {
  averageRanks,
  computeStrategyIc,
  computeStrategyIcDay,
  STRATEGY_IC_MIN_SAMPLE_DAYS,
  type StrategyIcDayInput,
} from './ic.js';

const TOL = 1e-6;

/** 独立复算：排序后取平均秩（与实现不同写法，避免自证）。 */
const at = (values: readonly number[], index: number): number => {
  const value = values[index];
  if (value === undefined) throw new Error(`missing fixture value at ${String(index)}`);
  return value;
};

const ranksFor = (values: readonly number[]): number[] => {
  const indexed = values.map((value, index) => ({ value, index }));
  const sorted = [...indexed].sort((a, b) => a.value - b.value);
  const rankByIndex = new Map<number, number>();
  let position = 0;
  while (position < sorted.length) {
    const head = sorted[position];
    if (head === undefined) break;
    let end = position;
    while (end + 1 < sorted.length && sorted[end + 1]?.value === head.value) end += 1;
    const rank = (position + end) / 2 + 1;
    for (let cursor = position; cursor <= end; cursor += 1) {
      const item = sorted[cursor];
      if (item !== undefined) rankByIndex.set(item.index, rank);
    }
    position = end + 1;
  }
  return indexed.map((item) => rankByIndex.get(item.index) ?? Number.NaN);
};

const pearsonRef = (x: readonly number[], y: readonly number[]): number => {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const xi = at(x, i) - mx;
    const yi = at(y, i) - my;
    num += xi * yi;
    dx += xi ** 2;
    dy += yi ** 2;
  }
  return num / Math.sqrt(dx * dy);
};

const spearmanRef = (x: readonly number[], y: readonly number[]): number =>
  pearsonRef(ranksFor(x), ranksFor(y));

/** 25 日固定样本：每日 6 只股票，score 固定，收益用固定置换。 */
const STOCKS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const SCORES = [10, 20, 30, 40, 50, 60] as const;
const dayReturns = (day: number): readonly number[] => {
  // 用固定表生成不同相关性：0..24 轮换三种形态（正相关 / 反相关 / 弱相关）。
  const shapes = [
    [0.01, 0.02, 0.03, 0.04, 0.05, 0.06],
    [0.06, 0.05, 0.04, 0.03, 0.02, 0.01],
    [0.03, -0.01, 0.05, 0.02, 0.0, 0.04],
  ];
  const shape = shapes[day % shapes.length];
  if (shape === undefined) throw new Error('missing fixture shape');
  return shape;
};
const dayInput = (
  day: number,
  vintage: StrategyIcDayInput['vintage'] = 'pit',
): StrategyIcDayInput => {
  const returns = dayReturns(day);
  return {
    dataAsOf: new Date(Date.UTC(2026, 0, 1 + day)),
    vintage,
    scores: STOCKS.map((stockId, index) => ({ stockId, score: at(SCORES, index) })),
    nextDayReturns: new Map(STOCKS.map((stockId, index) => [stockId, at(returns, index)] as const)),
  };
};

describe('T19 IC / RankIC', () => {
  it('25 日固定样本：逐日 RankIC 与 IR 等于独立复算值（1e-6）', () => {
    const inputs = Array.from({ length: 25 }, (_, day) => dayInput(day));
    const [pit] = computeStrategyIc(inputs);
    expect(pit?.vintage).toBe('pit');
    expect(pit?.status).toBe('ok');
    expect(pit?.sampleDays).toBe(25);

    // 逐日 RankIC 复算
    for (let day = 0; day < 25; day += 1) {
      const expected = spearmanRef([...SCORES], [...dayReturns(day)]);
      const actual = pit?.days[day]?.rankIc;
      expect(actual, `day ${day}`).toBeDefined();
      expect(Math.abs((actual ?? 0) - expected)).toBeLessThan(TOL);
    }

    // 均值 / 样本标准差(n−1) / IR 复算
    const rankIcs = Array.from({ length: 25 }, (_, day) =>
      spearmanRef([...SCORES], [...dayReturns(day)]),
    );
    const meanRef = rankIcs.reduce((s, v) => s + v, 0) / rankIcs.length;
    const variance = rankIcs.reduce((s, v) => s + (v - meanRef) ** 2, 0) / (rankIcs.length - 1);
    const stdRef = Math.sqrt(variance);
    expect(Math.abs((pit?.meanRankIc ?? 0) - meanRef)).toBeLessThan(TOL);
    expect(Math.abs((pit?.stdRankIc ?? 0) - stdRef)).toBeLessThan(TOL);
    expect(Math.abs((pit?.ir ?? 0) - meanRef / stdRef)).toBeLessThan(TOL);
    expect(pit?.positiveRatio).toBeCloseTo(rankIcs.filter((v) => v > 0).length / 25, 12);
  });

  it('手算参考值：3 只股票 × 5 天，Spearman 与 IR 与纸算一致（抓"两边同错"）', () => {
    // 纸算（scores 恒为 [10,20,30]，秩 1/2/3）：
    //   Spearman = 1 − 6Σd² / (n(n²−1))，n=3 → 分母 24
    //   收益秩 [1,3,2] → Σd²=2 → 0.5
    //   收益秩 [1,2,3] → Σd²=0 → 1
    //   收益秩 [3,2,1] → Σd²=8 → −1
    //   收益秩 [1,3,2] → 0.5
    //   收益秩 [2,3,1] → Σd²=6 → −0.5
    //   单周期序列 = [0.5, 1, −1, 0.5, −0.5]；重复 4 次得 20 日（低于 20 日会 unavailable）
    //   mean = 0.1
    //   样本方差 = 4 × (0.4²+0.9²+1.1²+0.4²+0.6²) / 19 = 4 × 2.70 / 19 = 10.8/19 = 0.568421052631579
    //   std = 0.7539370349250519；IR = 0.1 / std = 0.1326370709590369
    const cycle: readonly (readonly number[])[] = [
      [0.01, 0.03, 0.02],
      [0.01, 0.02, 0.03],
      [0.03, 0.02, 0.01],
      [0.01, 0.03, 0.02],
      [0.02, 0.03, 0.01],
    ];
    const permutations = [...cycle, ...cycle, ...cycle, ...cycle];
    const inputs: StrategyIcDayInput[] = permutations.map((returns, day) => ({
      dataAsOf: new Date(Date.UTC(2026, 2, 2 + day)),
      vintage: 'pit',
      scores: [
        { stockId: 'A', score: 10 },
        { stockId: 'B', score: 20 },
        { stockId: 'C', score: 30 },
      ],
      nextDayReturns: new Map([
        ['A', returns[0] ?? 0],
        ['B', returns[1] ?? 0],
        ['C', returns[2] ?? 0],
      ]),
    }));
    const [pit] = computeStrategyIc(inputs);
    expect(pit?.days.map((day) => day.rankIc)).toEqual([
      0.5, 1, -1, 0.5, -0.5, 0.5, 1, -1, 0.5, -0.5, 0.5, 1, -1, 0.5, -0.5, 0.5, 1, -1, 0.5, -0.5,
    ]);
    expect(pit?.sampleDays).toBe(20);
    expect(pit?.meanRankIc).toBeCloseTo(0.1, 12);
    expect(pit?.stdRankIc).toBeCloseTo(0.7539370349250519, 12);
    expect(pit?.ir).toBeCloseTo(0.1326370709590369, 12);
    expect(pit?.positiveRatio).toBeCloseTo(0.6, 12);
  });

  it('19 日返回 unavailable（不因"差一点"给数字）', () => {
    const inputs = Array.from({ length: 19 }, (_, day) => dayInput(day));
    const [pit] = computeStrategyIc(inputs);
    expect(pit?.status).toBe('unavailable');
    expect(pit?.unavailableReason).toBe('insufficient-sample');
    expect(pit?.sampleDays).toBe(19);
    expect(pit?.meanRankIc).toBeNull();
    expect(pit?.ir).toBeNull();
    expect(pit?.limitations.join('')).toContain('样本不足');
  });

  it('20 日恰好达标（边界）', () => {
    const inputs = Array.from({ length: STRATEGY_IC_MIN_SAMPLE_DAYS }, (_, day) => dayInput(day));
    const [pit] = computeStrategyIc(inputs);
    expect(pit?.status).toBe('ok');
    expect(pit?.sampleDays).toBe(20);
    expect(pit?.ir).not.toBeNull();
  });

  it('pit 与 restated 分组不混算：各自样本数与均值', () => {
    const inputs = [
      ...Array.from({ length: 25 }, (_, day) => dayInput(day, 'pit')),
      ...Array.from({ length: 21 }, (_, day) => dayInput(day, 'restated')),
    ];
    const groups = computeStrategyIc(inputs);
    expect(groups.map((group) => group.vintage)).toEqual(['pit', 'restated']);
    expect(groups.map((group) => group.sampleDays)).toEqual([25, 21]);
    // 两组均值各自独立：pit 的 25 天与 restated 的 21 天不能合并成一个数
    const pitOnly = computeStrategyIc(inputs.filter((input) => input.vintage === 'pit'));
    expect(groups[0]?.meanRankIc).toBeCloseTo(pitOnly[0]?.meanRankIc ?? Number.NaN, 12);
    expect(groups[0]?.limitations.join('')).not.toContain('restated');
    expect(groups[1]?.limitations.join('')).toContain('vintage=restated');
  });

  it('缺失日不填 0：横截面不足的日子进 missingDays 且不计入天数', () => {
    const good = dayInput(0);
    const thin: StrategyIcDayInput = {
      dataAsOf: new Date(Date.UTC(2026, 0, 2)),
      vintage: 'pit',
      scores: [
        { stockId: 'A', score: 10 },
        { stockId: 'B', score: 20 },
      ],
      nextDayReturns: new Map([
        ['A', 0.01],
        ['B', 0.02],
      ]),
    };
    const missingReturn: StrategyIcDayInput = {
      dataAsOf: new Date(Date.UTC(2026, 0, 3)),
      vintage: 'pit',
      scores: STOCKS.map((stockId, index) => ({ stockId, score: at(SCORES, index) })),
      nextDayReturns: new Map(),
    };
    const [pit] = computeStrategyIc([good, thin, missingReturn]);
    expect(pit?.sampleDays).toBe(1);
    expect(pit?.days).toHaveLength(1);
    expect(pit?.days[0]?.dataAsOf.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(pit?.missingDays.map((day) => day.reason)).toEqual([
      'insufficient-cross-section',
      'insufficient-cross-section',
    ]);
    // 关键：缺失日没有变成 0 分的一天
    expect(pit?.days.some((day) => day.rankIc === 0)).toBe(false);
  });

  it('平均秩处理并列（小样本）', () => {
    expect(averageRanks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });

  it('平均秩：大面积并列（20 个值里 10 个相同）仍正确', () => {
    // 涨跌停 / 停牌复牌会让真实数据出现大量同分。
    const values = [...Array<number>(10).fill(5), ...Array.from({ length: 10 }, (_, i) => 100 + i)];
    const ranks = averageRanks(values);
    // 前 10 个并列值占秩 1..10 → 平均 5.5
    expect(ranks.slice(0, 10)).toEqual(Array<number>(10).fill(5.5));
    // 后 10 个各不相同 → 秩 11..20
    expect(ranks.slice(10)).toEqual(Array.from({ length: 10 }, (_, i) => 11 + i));
    // 秩总和恒等于 n(n+1)/2
    expect(ranks.reduce((sum, value) => sum + value, 0)).toBeCloseTo((20 * 21) / 2, 12);
  });

  it('单日：评分无方差 → 缺失而不是 0', () => {
    const outcome = computeStrategyIcDay({
      dataAsOf: new Date(Date.UTC(2026, 0, 1)),
      vintage: 'pit',
      scores: STOCKS.map((stockId) => ({ stockId, score: 50 })),
      nextDayReturns: new Map(STOCKS.map((stockId, index) => [stockId, index / 100])),
    });
    expect('missing' in outcome && outcome.missing.reason).toBe('constant-scores');
  });
});
