import { describe, expect, it } from 'bun:test';

import { sectorTileStyle, selectSectorExtremes, sortSectorHeatmapItems } from './sector-heatmap.js';

const sector = (name, changePct) => ({
  code: name,
  name,
  price: 100,
  changePct,
  change: changePct,
  amount: 1,
});

describe('sector heatmap', () => {
  it('固定取涨跌两侧极值，不会只显示涨幅榜', () => {
    const items = [
      sector('up-1', 0.1),
      sector('up-2', 0.05),
      sector('up-3', 0.03),
      sector('down-1', -0.08),
      sector('down-2', -0.04),
    ];
    const selected = selectSectorExtremes(items, 2);
    expect(selected.map((item) => item.name)).toEqual(['up-1', 'up-2', 'down-2', 'down-1']);
  });

  it('热力图按涨幅降序排列，从红色过渡到绿色', () => {
    const items = [
      sector('down-large', -0.08),
      sector('up-small', 0.03),
      sector('flat', 0),
      sector('up-large', 0.1),
      sector('down-small', -0.04),
    ];

    expect(sortSectorHeatmapItems(items).map((item) => item.name)).toEqual([
      'up-large',
      'up-small',
      'flat',
      'down-small',
      'down-large',
    ]);
  });

  it('下跌板块使用负向颜色', () => {
    expect(sectorTileStyle(-0.02).background).toContain('15, 157, 88');
  });
});
