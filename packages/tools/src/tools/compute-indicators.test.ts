import { describe, expect, it } from 'vitest';
import { buildMockContext } from '../context.js';
import { computeIndicatorsTool } from './compute-indicators.js';

describe('tool/compute_indicators', () => {
  it('正常路径：返回 indicators + barsCount + dataAsOf', async () => {
    const ctx = await buildMockContext();
    const res = await computeIndicatorsTool.execute({ stockId: '002594.SZ' }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stockId).toBe('002594.SZ');
    expect(res.data.barsCount).toBeGreaterThan(0);
    // mock 出 60 根日线 → MA5/MA10/MA20 都能算
    expect(res.data.indicators.ma5).toBeDefined();
    expect(res.data.indicators.ma20).toBeDefined();
    expect(res.data.dataAsOf).toBeInstanceOf(Date);
  });

  it('正常路径：lookbackDays 自定义', async () => {
    const ctx = await buildMockContext();
    const res = await computeIndicatorsTool.execute(
      { stockId: '002594.SZ', lookbackDays: 30 },
      ctx,
    );
    expect(res.ok).toBe(true);
  });

  it('错误路径：stock 不存在 → not_found', async () => {
    const ctx = await buildMockContext();
    const res = await computeIndicatorsTool.execute({ stockId: 'NOPE' }, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('not_found');
  });

  it('错误路径：lookbackDays > 365 → invalid_input', async () => {
    const ctx = await buildMockContext();
    const res = await computeIndicatorsTool.execute(
      { stockId: '002594.SZ', lookbackDays: 500 },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_input');
  });
});
