// T19 / REQ-M3-13：`get_strategy_ic` 工具层验收。
//
// 这一层要证明的是**取数口径**，不是数学（数学在 core 的 ic.test.ts 里已独立复算）：
//   1. 收益必须是**次日**收益（防"用当日收益算当日信号"的前视）；
//   2. vintage 由观察事实判定，混合/缺失不猜；
//   3. 缺失日不补 0。
import type { SignalObservation, StrategyResult, ToolContext } from '@luoome/core';
import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { getStrategyIcTool } from './strategy-ic.js';

const STOCKS = ['A', 'B', 'C', 'D'] as const;

const bar = (stockId: string, iso: string, close: number) => ({
  stockId,
  date: new Date(iso),
  open: money(close),
  high: money(close),
  low: money(close),
  close: money(close),
  volume: 1,
  adjustment: 'qfq' as const,
  source: 'ic-fixture',
});

const result = (runId: string, stockId: string, score: number, dataAsOf: Date): StrategyResult => ({
  runId,
  stockId,
  selected: true,
  score,
  ruleEvaluations: [],
  evidence: [],
  dataAsOf,
});

const observation = (
  sourceId: string,
  vintage: SignalObservation['vintage'],
): SignalObservation => ({
  id: `signal-observation:strategy-signal:${sourceId}:t1`,
  sourceKind: 'strategy-signal',
  sourceId,
  stockId: STOCKS[0] ?? 'A',
  baselinePrice: 10,
  baselineAt: new Date('2026-01-05T00:00:00.000Z'),
  horizon: 't1',
  vintage,
  status: 'pending',
  benchmarkStatus: 'unavailable',
  provenance: {
    provider: 'fixture',
    observedAt: new Date('2026-01-05T00:00:00.000Z'),
    fetchedAt: new Date('2026-01-05T00:00:00.000Z'),
    freshness: 'unknown',
  },
});

interface StubOptions {
  readonly runs: readonly {
    id: string;
    dataAsOf: Date;
    strategyVersionId?: string;
    vintages: readonly SignalObservation['vintage'][];
    /** 该 run 的信号总数；缺省等于 vintages.length。 */
    signalCount?: number;
  }[];
  /** stockId → 日线（按时间升序）。 */
  readonly bars: Readonly<Record<string, readonly { date: string; close: number }[]>>;
}

const stubContext = (options: StubOptions): ToolContext => {
  const runs = options.runs.map((run) => ({
    id: run.id,
    strategyId: 'ic-strategy',
    strategyVersionId: run.strategyVersionId ?? 'ic-strategy-v1',
    mode: 'replay' as const,
    coverage: 'CN_A_SHARES_SH_SZ' as const,
    dataAsOf: run.dataAsOf,
    startedAt: run.dataAsOf,
    status: 'complete' as const,
    scope: 'evaluation' as const,
    inputSnapshot: {},
    summary: {},
  }));
  return {
    clock: () => new Date('2026-01-10T00:00:00.000Z'),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    user: { id: 'u', defaultAccountId: 'a' },
    repos: {
      strategyRun: {
        listRuns: async () => runs,
        listResultsByRuns: async (ids: readonly string[]) =>
          runs
            .filter((run) => ids.includes(run.id))
            .flatMap((run) =>
              STOCKS.map((stockId, index) =>
                result(run.id, stockId, (index + 1) * 10, run.dataAsOf),
              ),
            ),
        signalsByRun: async (runId: string) => {
          const run = options.runs.find((item) => item.id === runId);
          const total = run?.signalCount ?? run?.vintages.length ?? 0;
          return Array.from({ length: total }, (_, index) => ({
            id: `${runId}:signal:${String(index)}`,
            // 真实信号必然带 tracking（signal-policy.ts 发射时写入），否则不算可观察。
            evaluationSnapshot: {
              tracking: { policyVersion: 1, kind: 'entry', eligible: true },
            },
          }));
        },
      },
      signalObservation: {
        list: async (filter: { sourceIds?: readonly string[] }) => {
          const ids = filter.sourceIds ?? [];
          const runId = ids[0]?.split(':')[0] ?? '';
          const run = options.runs.find((item) => item.id === runId);
          return (run?.vintages ?? []).map((vintage, index) =>
            observation(`${runId}:signal:${String(index)}`, vintage),
          );
        },
      },
      dailyBar: {
        findInRange: async (stockId: string) =>
          (options.bars[stockId] ?? []).map((item) =>
            bar(stockId, `${item.date}T00:00:00.000Z`, item.close),
          ),
      },
    },
  } as unknown as ToolContext;
};

describe('T19 get_strategy_ic', () => {
  it('收益用次日：D=10、D+1=11、D+2=20 时必须取 11/10−1，不是 D+2 也不是当日', async () => {
    const ctx = stubContext({
      runs: [{ id: 'run-1', dataAsOf: new Date('2026-01-05T00:00:00.000Z'), vintages: ['pit'] }],
      bars: Object.fromEntries(
        STOCKS.map((stockId, index) => [
          stockId,
          [
            { date: '2026-01-05', close: 10 },
            // 次日收益随评分单调递增 → RankIC 必须正好 1
            { date: '2026-01-06', close: 10 + index },
            // D+2 与评分反向：错用 D+2 会得到 -1
            { date: '2026-01-07', close: 100 - index * 10 },
          ],
        ]),
      ),
    });
    const outcome = await getStrategyIcTool.execute({ strategyId: 'ic-strategy' }, ctx);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    const group = outcome.data.groups[0];
    expect(group?.vintage).toBe('pit');
    expect(group?.sampleDays).toBe(1);
    // 全部股票次日收益都是 0.1 → 与递增评分完全正相关 → RankIC = 1
    expect(group?.days[0]?.rankIc).toBeCloseTo(1, 12);
    expect(group?.days[0]?.ic).toBeCloseTo(1, 12);
  });

  it('若错用 D+2（20/11−1≈0.818）或当日收益，RankIC 不会等于 1 且数值不同', async () => {
    const ctx = stubContext({
      runs: [{ id: 'run-1', dataAsOf: new Date('2026-01-05T00:00:00.000Z'), vintages: ['pit'] }],
      bars: Object.fromEntries(
        STOCKS.map((stockId, index) => [
          stockId,
          [
            { date: '2026-01-05', close: 10 },
            { date: '2026-01-06', close: 10 + index },
            // D+2 与评分反向，错用就会得到负相关
            { date: '2026-01-07', close: 100 - index * 10 },
          ],
        ]),
      ),
    });
    const outcome = await getStrategyIcTool.execute({ strategyId: 'ic-strategy' }, ctx);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.data.groups[0]?.days[0]?.rankIc).toBeCloseTo(1, 12);
  });

  it('pit 与 restated 分组：同一响应里两组分开、各有样本数', async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 0, 5 + n));
    const ctx = stubContext({
      runs: [
        { id: 'run-pit', dataAsOf: day(0), vintages: ['pit'] },
        { id: 'run-restated', dataAsOf: day(1), vintages: ['restated'] },
      ],
      bars: Object.fromEntries(
        STOCKS.map((stockId, index) => [
          stockId,
          [
            { date: '2026-01-05', close: 10 },
            { date: '2026-01-06', close: 10 + index },
            { date: '2026-01-07', close: 10 + index * 2 },
          ],
        ]),
      ),
    });
    const outcome = await getStrategyIcTool.execute({ strategyId: 'ic-strategy' }, ctx);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.data.groups.map((group) => group.vintage)).toEqual(['pit', 'restated']);
    expect(outcome.data.groups.map((group) => group.sampleDays)).toEqual([1, 1]);
    expect(outcome.data.groups[1]?.limitations.join('')).toContain('vintage=restated');
  });

  it('vintage 缺失或混合：跳过该日并给原因，不猜口径', async () => {
    const ctx = stubContext({
      runs: [
        { id: 'run-none', dataAsOf: new Date('2026-01-05T00:00:00.000Z'), vintages: [] },
        {
          id: 'run-mixed',
          dataAsOf: new Date('2026-01-06T00:00:00.000Z'),
          vintages: ['pit', 'restated'],
        },
      ],
      bars: Object.fromEntries(
        STOCKS.map((stockId, index) => [
          stockId,
          [
            { date: '2026-01-05', close: 10 },
            { date: '2026-01-06', close: 10 + index },
            { date: '2026-01-07', close: 10 + index * 2 },
          ],
        ]),
      ),
    });
    const outcome = await getStrategyIcTool.execute({ strategyId: 'ic-strategy' }, ctx);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.data.groups).toEqual([]);
    expect(outcome.data.skippedDays.map((day) => day.reason)).toEqual([
      'vintage-unknown',
      'vintage-mixed',
    ]);
  });

  it('100 个信号只有 1 个观察：不因此把整个 run 标成某 vintage（vintage-partial）', async () => {
    const ctx = stubContext({
      runs: [
        {
          id: 'run-partial',
          dataAsOf: new Date('2026-01-05T00:00:00.000Z'),
          vintages: ['pit'],
          signalCount: 100,
        },
      ],
      bars: Object.fromEntries(
        STOCKS.map((stockId, index) => [
          stockId,
          [
            { date: '2026-01-05', close: 10 },
            { date: '2026-01-06', close: 10 + index },
          ],
        ]),
      ),
    });
    const outcome = await getStrategyIcTool.execute({ strategyId: 'ic-strategy' }, ctx);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    // 关键：不能因为 1 个观察就把 100 个信号的日子算成 pit 样本
    expect(outcome.data.groups).toEqual([]);
    expect(outcome.data.skippedDays).toEqual([
      { dataAsOf: new Date('2026-01-05T00:00:00.000Z'), reason: 'vintage-partial' },
    ]);
  });

  it('同日多 run：取首个，其余显式进 skippedDays（duplicate-day）', async () => {
    const day = new Date('2026-01-05T00:00:00.000Z');
    const ctx = stubContext({
      runs: [
        { id: 'run-newer', dataAsOf: day, vintages: ['pit'] },
        { id: 'run-older', dataAsOf: day, vintages: ['restated'] },
      ],
      bars: Object.fromEntries(
        STOCKS.map((stockId, index) => [
          stockId,
          [
            { date: '2026-01-05', close: 10 },
            { date: '2026-01-06', close: 10 + index },
          ],
        ]),
      ),
    });
    const outcome = await getStrategyIcTool.execute({ strategyId: 'ic-strategy' }, ctx);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    // listRuns 按 startedAt 倒序 → 取 run-newer（pit）
    expect(outcome.data.groups.map((group) => group.vintage)).toEqual(['pit']);
    expect(outcome.data.groups[0]?.sampleDays).toBe(1);
    expect(outcome.data.skippedDays.map((item) => item.reason)).toEqual(['duplicate-day']);
  });

  it('乱序日线：无论返回顺序，都取"该日或之前最近"与"该日之后第一根"', async () => {
    const ctx = stubContext({
      runs: [{ id: 'run-1', dataAsOf: new Date('2026-01-06T00:00:00.000Z'), vintages: ['pit'] }],
      // 故意打乱顺序：D+2、D、D+1
      bars: Object.fromEntries(
        STOCKS.map((stockId, index) => [
          stockId,
          [
            { date: '2026-01-08', close: 999 },
            { date: '2026-01-06', close: 10 },
            { date: '2026-01-07', close: 10 + index },
          ],
        ]),
      ),
    });
    const outcome = await getStrategyIcTool.execute({ strategyId: 'ic-strategy' }, ctx);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    // 次日收益 = (10+index)/10 − 1，随评分递增 → RankIC = 1；错取 999 会得到别的值
    expect(outcome.data.groups[0]?.days[0]?.rankIc).toBeCloseTo(1, 12);
  });

  it('零信号日：有评分横截面但无信号 → 计入 scoreOnlyDays（标注限制，不是算不出来）', async () => {
    const ctx = stubContext({
      runs: [{ id: 'run-quiet', dataAsOf: new Date('2026-01-05T00:00:00.000Z'), vintages: [] }],
      bars: Object.fromEntries(
        STOCKS.map((stockId, index) => [
          stockId,
          [
            { date: '2026-01-05', close: 10 },
            { date: '2026-01-06', close: 10 + index },
          ],
        ]),
      ),
    });
    const outcome = await getStrategyIcTool.execute({ strategyId: 'ic-strategy' }, ctx);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.data.groups).toEqual([]);
    expect(outcome.data.scoreOnlyDays).toBe(1);
    expect(outcome.data.skippedDays.map((item) => item.reason)).toEqual(['vintage-unknown']);
    expect(outcome.data.limitations.join('')).toContain('标注限制，不是统计上算不出来');
  });

  it('非零信号但覆盖不全 → vintage-partial，且不计入 scoreOnlyDays', async () => {
    const ctx = stubContext({
      runs: [
        {
          id: 'run-partial',
          dataAsOf: new Date('2026-01-05T00:00:00.000Z'),
          vintages: ['pit'],
          signalCount: 100,
        },
      ],
      bars: Object.fromEntries(
        STOCKS.map((stockId, index) => [
          stockId,
          [
            { date: '2026-01-05', close: 10 },
            { date: '2026-01-06', close: 10 + index },
          ],
        ]),
      ),
    });
    const outcome = await getStrategyIcTool.execute({ strategyId: 'ic-strategy' }, ctx);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.data.scoreOnlyDays).toBe(0);
    expect(outcome.data.skippedDays.map((item) => item.reason)).toEqual(['vintage-partial']);
  });

  it('缺次日收益的股票不进配对；整日缺收益则进 missingDays 而不是 0', async () => {
    const ctx = stubContext({
      runs: [{ id: 'run-1', dataAsOf: new Date('2026-01-05T00:00:00.000Z'), vintages: ['pit'] }],
      bars: Object.fromEntries(
        STOCKS.map((stockId) => [stockId, [{ date: '2026-01-05', close: 10 }]]),
      ),
    });
    const outcome = await getStrategyIcTool.execute({ strategyId: 'ic-strategy' }, ctx);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    const group = outcome.data.groups[0];
    expect(group?.sampleDays).toBe(0);
    expect(group?.status).toBe('unavailable');
    expect(group?.missingDays[0]?.reason).toBe('insufficient-cross-section');
    expect(group?.meanRankIc).toBeNull();
  });
});
