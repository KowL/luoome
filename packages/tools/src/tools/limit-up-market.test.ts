import {
  type LimitUpMarketManagerLike,
  LimitUpMarketQuerySchema,
  type LimitUpMarketSnapshot,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { limitUpMarketTool } from './limit-up-market.js';

const snapshot = (overrides: Partial<LimitUpMarketSnapshot> = {}): LimitUpMarketSnapshot => ({
  date: '2026-11-12',
  source: 'fuyao',
  asOf: new Date('2026-11-12T07:02:00Z'),
  dataAsOf: new Date('2026-11-12T07:00:00Z'),
  pool: {
    total: 1,
    entries: [
      {
        stockId: '600327.SH',
        code: '600327',
        name: '大东方',
        isSt: false,
        isNew: false,
        price: 7.18,
        changePct: 0.099541,
        limitUpTime: '14:56',
        openTimes: null,
        reason: '百货零售',
        continueDayText: '5连板',
        continueDayCnt: 5,
        sealMoney: 27_188_276,
        maxSealMoney: 27_188_276.24,
      },
    ],
  },
  statistics: null,
  ladder: null,
  warnings: [],
  ...overrides,
});

const mkManager = (
  fetchMarket: LimitUpMarketManagerLike['fetchMarket'],
): LimitUpMarketManagerLike => ({
  name: 'limit-up-market',
  sources: ['fuyao'],
  fetchMarket,
});

describe('limit_up_market tool', () => {
  const makeCtx = (manager: LimitUpMarketManagerLike | undefined) =>
    ({
      repos: {} as never,
      adapters: { market: {} as never, llm: {} as never, marketIntel: { limitUpMarket: manager } },
      user: { id: 'u1', defaultAccountId: 'a1' },
      clock: () => new Date(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }) as never;

  it('manager 未注入（未配置 FUYAO_API_KEY）→ invalid_input', async () => {
    const r = await limitUpMarketTool.execute(
      LimitUpMarketQuerySchema.parse({ date: '2026-11-12' }),
      makeCtx(undefined),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    expect(r.error.kind === 'invalid_input' && r.error.message).toContain('FUYAO_API_KEY');
  });

  it('成功 → 原样返回快照', async () => {
    const r = await limitUpMarketTool.execute(
      LimitUpMarketQuerySchema.parse({ date: '2026-11-12' }),
      makeCtx(mkManager(async () => ({ ok: true, data: snapshot() }))),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.snapshot.date).toBe('2026-11-12');
    expect(r.data.snapshot.pool?.entries[0]?.continueDayCnt).toBe(5);
    // KPI 与原因分布由 core 派生
    expect(r.data.metrics.maxBoard).toBe(5);
    expect(r.data.metrics.sealAmount).toBe(27_188_276);
    expect(r.data.reasons).toEqual([{ reason: '百货零售', count: 1 }]);
  });

  it('manager 失败 → adapter_error（不抛异常）', async () => {
    const r = await limitUpMarketTool.execute(
      LimitUpMarketQuerySchema.parse({ date: '2026-11-12' }),
      makeCtx(
        mkManager(async () => ({
          ok: false,
          error: {
            kind: 'adapter_error',
            adapter: 'limit-up-market',
            message: '所有涨停市场端点失败',
            recoverable: false,
          },
        })),
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('adapter_error');
  });

  it('date 非法 → invalid_input', async () => {
    const r = await limitUpMarketTool.execute(
      { date: '2026/11/12' },
      makeCtx(mkManager(async () => ({ ok: true, data: snapshot() }))),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });
});
