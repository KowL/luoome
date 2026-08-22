/* apps/web/public/js/indices.test.js —— 指数页分时模型纯函数单测。 */

import { describe, expect, it } from 'bun:test';

import { buildIntradayModel, prevCloseOf } from './indices.js';

const pt = (time, price, cumVolume = 1000, cumAmount = price * cumVolume) => ({
  stockId: '000001.SH',
  time,
  price,
  cumVolume,
  cumAmount,
  source: 'tencent',
});

describe('buildIntradayModel', () => {
  it('价格 / 纵轴范围（不含量额）/ 极值 / 末点累计量额', () => {
    const model = buildIntradayModel(
      [
        pt('2026-08-21T09:31:00+08:00', 3800, 1000),
        pt('2026-08-21T09:32:00+08:00', 3820, 2000, 3800 * 1000 + 3820 * 1000),
        pt('2026-08-21T09:33:00+08:00', 3810, 3000),
      ],
      3790,
    );
    expect(model).not.toBeNull();
    expect(model.prices).toEqual([3800, 3820, 3810]);
    expect(model.open).toBe(3800);
    expect(model.high).toBe(3820);
    expect(model.low).toBe(3800);
    expect(model.base).toBe(3790);
    expect(model.lastVolume).toBe(3000);
    expect(model.lastAmount).toBe(3810 * 3000);
    expect(model.labels).toEqual(['09:31', '09:32', '09:33']);
  });

  it('纵轴范围只由价格与昨收决定（指数 cumAmount/cumVolume 是全市场口径，不参与绘图）', () => {
    // tencent 指数分钟数据的 cumAmount/cumVolume 相除 ≈ 17（不是指数点位），
    // 若混入 min/max 会把价格线压扁到顶部——回归锁定。
    const model = buildIntradayModel(
      [pt('2026-08-21T09:31:00+08:00', 3800, 416_819_100, 7_276_088_191.9)],
      3790,
    );
    expect(model.min).toBeGreaterThan(3700);
    expect(model.max).toBeLessThan(3900);
  });

  it('preClose 缺失（null）时基准退化为首分钟价', () => {
    const model = buildIntradayModel([pt('2026-08-21T09:31:00+08:00', 3800)], null);
    expect(model.base).toBe(3800);
  });

  it('空序列 / 全非法价 → null（调用方显示占位）', () => {
    expect(buildIntradayModel([], 3790)).toBeNull();
    expect(buildIntradayModel([{ price: -1 }, { price: 'x' }], 3790)).toBeNull();
    expect(buildIntradayModel(undefined, 3790)).toBeNull();
  });
});

describe('prevCloseOf', () => {
  it('close - change；无快照为 null', () => {
    expect(prevCloseOf({ close: 3880.5, change: 12.3 })).toBeCloseTo(3868.2);
    expect(prevCloseOf(null)).toBeNull();
    expect(prevCloseOf(undefined)).toBeNull();
  });
});
