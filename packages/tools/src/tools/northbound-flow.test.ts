import {
  type NorthboundFlowManagerLike,
  NorthboundFlowQuerySchema,
  type NorthboundFlowSeries,
} from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { northboundFlowTool } from './northbound-flow.js';

const mkSeries = (endDate: string): NorthboundFlowSeries => ({
  endDate,
  days: 2,
  source: 'eastmoney',
  series: [
    {
      date: '2026-08-20',
      netAmount: null,
      buyAmount: null,
      sellAmount: null,
      dealAmount: 278_374_950_000,
    },
    {
      date: '2026-08-21',
      netAmount: null,
      buyAmount: null,
      sellAmount: null,
      dealAmount: 268_087_540_000,
    },
  ],
  warnings: ['net-undisclosed: 2024-08-16 起交易所不再披露北向每日净买入'],
  asOf: new Date(),
});

const mkManager = (
  fetchImpl: NorthboundFlowManagerLike['fetchSeries'],
): NorthboundFlowManagerLike => ({
  name: 'northbound-flow',
  sources: ['eastmoney'],
  status: () => [],
  fetchSeries: fetchImpl,
});

describe('northbound_flow tool', () => {
  const makeCtx = (manager: NorthboundFlowManagerLike | undefined) =>
    ({
      repos: {} as never,
      adapters: { market: {} as never, llm: {} as never },
      northboundFlow: manager,
      user: { id: 'u1', defaultAccountId: 'a1' },
      clock: () => new Date(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }) as never;

  it('manager 未注入 → invalid_input', async () => {
    const r = await northboundFlowTool.execute(
      NorthboundFlowQuerySchema.parse({ endDate: '2026-08-21' }),
      makeCtx(undefined),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('manager 成功 → 返回序列', async () => {
    const series = mkSeries('2026-08-21');
    const manager = mkManager(vi.fn(async () => ({ ok: true, data: series })));
    const r = await northboundFlowTool.execute(
      NorthboundFlowQuerySchema.parse({ days: 2, endDate: '2026-08-21' }),
      makeCtx(manager),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.endDate).toBe('2026-08-21');
    expect(r.data.series).toHaveLength(2);
    expect(r.data.series[1]?.netAmount).toBeNull();
  });

  it('manager 失败 → adapter_error 透传', async () => {
    const manager = mkManager(
      vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: 'adapter_error' as const,
          adapter: 'northbound-flow' as const,
          message: 'down',
          recoverable: false,
        },
      })),
    );
    const r = await northboundFlowTool.execute(
      NorthboundFlowQuerySchema.parse({ endDate: '2026-08-21' }),
      makeCtx(manager),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('adapter_error');
    if (r.error.kind === 'adapter_error') {
      expect(r.error.adapter).toBe('northbound-flow');
      expect(r.error.cause).toMatch(/down/);
    }
  });

  it('days 默认 30；越界输入 → invalid_input', async () => {
    const fetchSeries = vi.fn(async () => ({ ok: true as const, data: mkSeries('2026-08-21') }));
    const manager = mkManager(fetchSeries);
    const r = await northboundFlowTool.execute({}, makeCtx(manager));
    expect(r.ok).toBe(true);
    expect(fetchSeries).toHaveBeenCalledWith({ days: 30 });

    const bad = await northboundFlowTool.execute({ days: 9999 }, makeCtx(manager));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.kind).toBe('invalid_input');
  });
});
