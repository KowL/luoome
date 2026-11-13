import { type DragonTigerFlowManagerLike, DragonTigerFlowQuerySchema } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { dragonTigerFlowTool } from './dragon-tiger-flow.js';

const flow = {
  startDate: '2026-11-10',
  endDate: '2026-11-11',
  days: 2,
  board: 'all' as const,
  rangeDays: 1 as const,
  source: 'fuyao',
  tradingDates: ['2026-11-10', '2026-11-11'],
  stats: {
    stockCount: 2,
    detailCount: 2,
    buyAmount: 100,
    sellAmount: 50,
    netAmount: 50,
    orgNetAmount: 20,
    hotNetAmount: 10,
    top5Concentration: 1,
    conceptCount: 1,
  },
  concepts: [
    {
      name: '黄金',
      series: [30, 50],
      netAmount: 50,
      orgNetAmount: 20,
      hotNetAmount: 10,
      otherNetAmount: 20,
      stockCount: 2,
      stocks: [],
    },
  ],
  warnings: [],
  asOf: new Date('2026-11-11T10:00:00Z'),
};

const mkManager = (
  fetchFlow: DragonTigerFlowManagerLike['fetchFlow'],
): DragonTigerFlowManagerLike => ({
  name: 'dragon-tiger-flow',
  sources: ['fuyao'],
  status: () => [],
  fetchFlow,
});

const makeCtx = (manager: DragonTigerFlowManagerLike | undefined) =>
  ({
    repos: {} as never,
    adapters: { market: {} as never, llm: {} as never, marketIntel: { dragonTigerFlow: manager } },
    user: { id: 'u1', defaultAccountId: 'a1' },
    clock: () => new Date(),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  }) as never;

describe('dragon_tiger_flow tool', () => {
  it('manager 未注入 → invalid_input（提示 FUYAO_API_KEY）', async () => {
    const r = await dragonTigerFlowTool.execute(
      DragonTigerFlowQuerySchema.parse({ date: '2026-11-11' }),
      makeCtx(undefined),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    expect(JSON.stringify(r.error)).toContain('FUYAO_API_KEY');
  });

  it('manager 成功 → 返回概念轨迹', async () => {
    const manager = mkManager(vi.fn(async () => ({ ok: true, data: flow })));
    const r = await dragonTigerFlowTool.execute(
      DragonTigerFlowQuerySchema.parse({ date: '2026-11-11', days: 5, board: 'org' }),
      makeCtx(manager),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.concepts[0]?.name).toBe('黄金');
    expect(manager.fetchFlow).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-11-11', days: 5, board: 'org', rangeDays: 1 }),
    );
  });

  it('manager 失败 → adapter_error 透传 recoverable', async () => {
    const manager = mkManager(
      vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: 'adapter_error' as const,
          adapter: 'dragon-tiger-flow' as const,
          message: 'fuyao timeout',
          recoverable: true,
        },
      })),
    );
    const r = await dragonTigerFlowTool.execute(
      DragonTigerFlowQuerySchema.parse({}),
      makeCtx(manager),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('adapter_error');
    expect(r.error).toMatchObject({ adapter: 'dragon-tiger-flow', recoverable: true });
  });

  it('入参非法（days=7）→ invalid_input', async () => {
    const r = await dragonTigerFlowTool.execute({ days: 7 }, makeCtx(undefined));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });
});
