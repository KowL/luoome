import {
  type LimitUpLadder,
  type LimitUpLadderCompareResultLike,
  type LimitUpLadderManagerLike,
  LimitUpLadderQuerySchema,
  type LimitUpLadderResultLike,
} from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { limitUpLadderCompareTool, limitUpLadderTool } from './limit-up-ladder.js';

const mkLadder = (date: string): LimitUpLadder => ({
  date,
  total: 1,
  maxLevel: 1,
  source: 'eastmoney',
  levels: [{ level: 1, name: '首板', count: 1, stocks: [] }],
  warnings: [],
  asOf: new Date(),
});

const mkManager = (
  fetchImpl: (q: any) => Promise<LimitUpLadderResultLike>,
  compareImpl: (d: string, pd: string, q: any) => Promise<LimitUpLadderCompareResultLike>,
): LimitUpLadderManagerLike => ({
  name: 'limit-up-ladder',
  fetchLadder: fetchImpl,
  compareLadder: compareImpl,
});

describe('limit_up_ladder tool', () => {
  const makeCtx = (manager: LimitUpLadderManagerLike | undefined) =>
    ({
      repos: {} as never,
      adapters: { market: {} as never, llm: {} as never },
      limitUpLadder: manager,
      user: { id: 'u1', defaultAccountId: 'a1' },
      clock: () => new Date(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }) as never;

  it('manager 未注入 → invalid_input', async () => {
    const r = await limitUpLadderTool.execute(
      LimitUpLadderQuerySchema.parse({ date: '2026-07-25' }),
      makeCtx(undefined),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('manager 成功 → 返回 ladder', async () => {
    const ladder = mkLadder('2026-07-25');
    const manager = mkManager(
      vi.fn(async () => ({ ok: true, data: ladder })),
      vi.fn(),
    );
    const r = await limitUpLadderTool.execute(
      LimitUpLadderQuerySchema.parse({ date: '2026-07-25' }),
      makeCtx(manager),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.date).toBe('2026-07-25');
  });

  it('manager 失败 → 异常被 define-tool 转为 internal', async () => {
    const manager = mkManager(
      vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: 'adapter_error' as const,
          adapter: 'limit-up-ladder' as const,
          message: 'down',
          recoverable: false,
        },
      })),
      vi.fn(),
    );
    const r = await limitUpLadderTool.execute(
      LimitUpLadderQuerySchema.parse({ date: '2026-07-25' }),
      makeCtx(manager),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('adapter_error');
    if (r.error.kind === 'adapter_error') {
      expect(r.error.adapter).toBe('limit-up-ladder');
      expect(r.error.cause).toMatch(/down/);
    }
  });
});

describe('limit_up_ladder_compare tool', () => {
  const makeCtx = (manager: LimitUpLadderManagerLike | undefined) =>
    ({
      repos: {} as never,
      adapters: { market: {} as never, llm: {} as never },
      limitUpLadder: manager,
      user: { id: 'u1', defaultAccountId: 'a1' },
      clock: () => new Date(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }) as never;

  it('manager 未注入 → invalid_input', async () => {
    const r = await limitUpLadderCompareTool.execute(
      { date: '2026-07-25', prevDate: '2026-07-24' },
      makeCtx(undefined),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('manager 成功 → 返回 compare output', async () => {
    const curr = mkLadder('2026-07-25');
    const prev = mkLadder('2026-07-24');
    const manager = mkManager(
      vi.fn(),
      vi.fn(async () => ({
        ok: true,
        data: {
          curr,
          prev,
          diff: {
            totalDelta: 0,
            maxLevelDelta: 0,
            topLevelAdded: [],
            topLevelRemoved: [],
            topLevelRetained: [],
          },
        },
      })),
    );
    const r = await limitUpLadderCompareTool.execute(
      { date: '2026-07-25', prevDate: '2026-07-24' },
      makeCtx(manager),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.curr.date).toBe('2026-07-25');
    expect(r.data.prev.date).toBe('2026-07-24');
  });

  it('compare manager 失败 → 返回 adapter_error', async () => {
    const manager = mkManager(
      vi.fn(),
      vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: 'adapter_error' as const,
          adapter: 'limit-up-ladder' as const,
          message: 'down',
          recoverable: false,
        },
      })),
    );
    const r = await limitUpLadderCompareTool.execute(
      { date: '2026-07-25', prevDate: '2026-07-24' },
      makeCtx(manager),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('adapter_error');
  });
});
