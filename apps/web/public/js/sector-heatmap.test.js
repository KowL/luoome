import { describe, expect, it } from 'bun:test';

import { sectorTileStyle, selectSectorExtremes } from './sector-heatmap.js';

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
    expect(selected.map((item) => item.name).sort()).toEqual(['down-1', 'down-2', 'up-1', 'up-2']);
  });

  it('下跌板块使用负向颜色', () => {
    expect(sectorTileStyle(-0.02).background).toContain('15, 157, 88');
  });
});
