/* apps/web/public/js/advice-wording.test.js —— design §12.2 展示层词表回归。
 *
 * 后端 decision / 今日判断枚举不改名；这里只断言用户可见标签与价格字段展示名。
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { BRIEF_DISCLAIMER } from './stock-brief.js';
import { adviceLevelLines, DECISIONS, decisionLabel } from './ui.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const BANNED = /建议买入|建议卖出|建仓|加仓|减仓|清仓|满仓/;
const RESEARCH_DISCLAIMER = '仅技术研究，不构成投资建议';

describe('建议 / 观察展示词表', () => {
  it('decision 映射为信号与观察词表，不出现买入/卖出', () => {
    expect(decisionLabel('buy')).toBe('偏多信号');
    expect(decisionLabel('sell')).toBe('偏空信号');
    expect(decisionLabel('hold')).toBe('中性观察');
    expect(decisionLabel('watch')).toBe('待确认观察');
    expect(decisionLabel('avoid')).toBe('回避观察');
    for (const cfg of Object.values(DECISIONS)) expect(cfg.label).not.toMatch(BANNED);
  });

  it('价格字段展示为观察区间 / 区间参考点 / 风险位 / 参考位 / 仓位参考', () => {
    const lines = adviceLevelLines({
      entryPriceLow: 98,
      entryPriceHigh: 103,
      entryPrice: 100,
      stopLoss: 95,
      targetPrice: 112,
      targetPositionPct: 10,
    });
    expect(lines).toEqual([
      '观察区间 98.00–103.00',
      '风险位 95.00',
      '参考位 112.00',
      '仓位参考 10.0%（占账户总资产）',
    ]);
    expect(lines.join(' · ')).not.toMatch(/入场|买点|止损|目标/);
    expect(adviceLevelLines({ entryPrice: 100 })).toEqual(['区间参考点 100.00']);
    expect(adviceLevelLines({})).toEqual([]);
  });

  it('个股观察免责声明带「仅技术研究，不构成投资建议」', () => {
    expect(BRIEF_DISCLAIMER).toContain(RESEARCH_DISCLAIMER);
  });
});

describe('建议 / 观察入口脚注', () => {
  it('建议页、关注列表、行情观察与对话边界均带研究免责声明', () => {
    const html = read('../index.html');
    expect(html).toContain('本内容仅技术研究，不构成投资建议；投资有风险，决策需自行承担。');
    expect(html).toContain('AI 分析仅技术研究，不构成投资建议');
    const disclaimerCount = html.split(RESEARCH_DISCLAIMER).length - 1;
    expect(disclaimerCount).toBeGreaterThanOrEqual(4);
  });

  it('作战室外壳保留固定脚注', () => {
    const source = read('./market-room.js');
    expect(source).toContain('ROOM_DISCLAIMER');
    expect(source).toContain(RESEARCH_DISCLAIMER);
  });
});
