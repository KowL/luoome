import { describe, expect, it } from 'vitest';

import { holdingPriceView, holdingSortValue, holdingsTotalsView } from './holdings-price.js';

/**
 * task-26：`apps/web` 的持仓价格判据。
 *
 * `apps/web/public/js/**` 是 `.js`、**不在 typecheck 覆盖内**，所以这里用纯函数单测把
 * 「判据来自服务端 `priceStatus`、不从字段缺失反推」这条纪律钉住。
 * 语义必须与 `packages/dsh-luoome/src/client/projection.js` 的 `holdingPriceView` 一致。
 */

/** 有价：S3 之后的形状（`priceStatus: 'priced'` + 数字字段齐全）。 */
const priced = { priceStatus: 'priced', currentPrice: 10.5, marketValue: 1050, pnl: 50, pnlPct: 5 };

/** 缺价：S3 之后的形状（`priceStatus: 'unpriced'` + 数字字段**缺席**）。 */
const unpriced = {
  priceStatus: 'unpriced',
  priceUnavailableReason: '缺价：该标的没有可用行情',
};

/** 老载荷：连 `priceStatus` 都没有。 */
const legacy = { currentPrice: 10.5, pnl: 0 };

describe('task-26 holdingPriceView 判据', () => {
  it('priced → 允许渲染数字（真实 0 盈亏也要能显示 0.00%）', () => {
    expect(holdingPriceView({ ...priced, pnl: 0, pnlPct: 0 })).toEqual({
      unpriced: false,
      unavailableText: null,
      canShowNumbers: true,
    });
  });

  it('unpriced → 不许渲染数字，给服务端原因', () => {
    const view = holdingPriceView(unpriced);
    expect(view.canShowNumbers).toBe(false);
    expect(view.unpriced).toBe(true);
    expect(view.unavailableText).toBe('缺价：该标的没有可用行情');
  });

  it('无 priceStatus 的老载荷 → 同样不许渲染数字（不编数）', () => {
    const view = holdingPriceView(legacy);
    expect(view.canShowNumbers).toBe(false);
    // 「不是缺价」但「也不能显示」——两者不同，canShowNumbers 是唯一渲染闸门。
    expect(view.unpriced).toBe(false);
  });

  it('判据只看 priceStatus：有数字但 priceStatus=unpriced 仍不给渲染', () => {
    const inconsistent = { priceStatus: 'unpriced', currentPrice: 99, pnl: 1 };
    expect(holdingPriceView(inconsistent).canShowNumbers).toBe(false);
  });

  it('判据不看字段缺失：没有 currentPrice 但 priceStatus=priced 仍可渲染', () => {
    // 字段缺失可能是别的 bug；判据是服务端声明，不是「键在不在」。
    expect(holdingPriceView({ priceStatus: 'priced' }).canShowNumbers).toBe(true);
  });
});

describe('task-26 排序键', () => {
  it('缺价 → null（不可比较），不返回 0', () => {
    expect(holdingSortValue(unpriced, 'pnlPct')).toBeNull();
    expect(holdingSortValue(unpriced, 'currentPrice')).toBeNull();
    // 关键：不能是 0 —— 0 会被当成「真实的最小值」参与排序。
    expect(holdingSortValue(unpriced, 'pnlPct')).not.toBe(0);
  });

  it('priced → 原值；非有限数 → null', () => {
    expect(holdingSortValue(priced, 'pnlPct')).toBe(5);
    expect(holdingSortValue({ priceStatus: 'priced', pnlPct: Number.NaN }, 'pnlPct')).toBeNull();
    expect(holdingSortValue({ priceStatus: 'priced' }, 'pnlPct')).toBeNull();
  });
});

describe('task-26 合计层', () => {
  it('有缺价 → 合计不可用，并给「含缺价持仓（N）」而不是 0', () => {
    const view = holdingsTotalsView({ unpricedCount: 2, totalValue: undefined });
    expect(view.canShowTotals).toBe(false);
    expect(view.note).toBe('含缺价持仓（2）');
    expect(view.partiallyUnpriced).toBe(true);
  });

  it('无缺价 + 有 totalValue → 可显示合计', () => {
    expect(holdingsTotalsView({ unpricedCount: 0, totalValue: 1000 })).toMatchObject({
      canShowTotals: true,
      note: null,
    });
  });
});
