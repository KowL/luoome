import type { LimitUpLadder } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { formatLimitUpLadderLines } from './limit-up-ladder.js';

const baseLadder = (overrides: Partial<LimitUpLadder> = {}): LimitUpLadder => ({
  date: '2026-07-25',
  total: 0,
  maxLevel: 0,
  source: 'adshare',
  levels: [],
  warnings: [],
  asOf: new Date(),
  ...overrides,
});

describe('formatLimitUpLadderLines', () => {
  it('空 levels + non-trading-day warning → 显示非交易日', () => {
    const lines = formatLimitUpLadderLines(baseLadder({ warnings: ['non-trading-day'] }));
    expect(lines.some((l) => l.includes('非 A 股交易日'))).toBe(true);
  });

  it('空 levels + empty-ladder warning → 显示数据未更新', () => {
    const lines = formatLimitUpLadderLines(baseLadder({ warnings: ['empty-ladder'] }));
    expect(lines.some((l) => l.includes('数据暂未更新'))).toBe(true);
  });

  it('多 level + 多股 → 按 level DESC 渲染 + 标题包含 count', () => {
    const lines = formatLimitUpLadderLines(
      baseLadder({
        total: 4,
        maxLevel: 3,
        levels: [
          {
            level: 3,
            name: '3 连板',
            count: 1,
            stocks: [
              {
                code: '600000',
                name: '浦发',
                industry: '银行',
                ladderLevel: 3,
                uncategorized: false,
                firstTime: '10:00:00',
                finalTime: '10:00:00',
                reason: '重组',
                price: 10.5,
                rawClose: 10.5,
                corrected: false,
                changePct: 0.1,
                limitUpDate: '2026-07-25',
                board: 'main_board',
              },
            ],
          },
          {
            level: 1,
            name: '首板',
            count: 3,
            stocks: [
              {
                code: '000001',
                name: '平安',
                industry: '保险',
                ladderLevel: 1,
                uncategorized: false,
                firstTime: '11:00:00',
                finalTime: '14:00:00',
                reason: '--',
                price: 12.34,
                rawClose: 12.34,
                corrected: false,
                changePct: 0.1,
                limitUpDate: '2026-07-25',
                board: 'main_board',
              },
              {
                code: '600002',
                name: '齐鲁',
                industry: '钢铁',
                ladderLevel: 1,
                uncategorized: false,
                firstTime: null,
                finalTime: null,
                reason: '涨价',
                price: 9.99,
                rawClose: 9.99,
                corrected: false,
                changePct: 0.099,
                limitUpDate: '2026-07-25',
                board: 'main_board',
              },
              {
                code: '300100',
                name: '同行',
                industry: '电子',
                ladderLevel: 1,
                uncategorized: false,
                firstTime: '14:30:00',
                finalTime: '14:30:00',
                reason: '概念',
                price: 20.0,
                rawClose: 20.0,
                corrected: true,
                changePct: 0.099,
                limitUpDate: '2026-07-25',
                board: 'chinext',
              },
            ],
          },
        ],
      }),
    );
    expect(lines.some((l) => l.includes('3 连板 (1 只)'))).toBe(true);
    expect(lines.some((l) => l.includes('首板 (3 只)'))).toBe(true);
    expect(lines.some((l) => l.includes('600000'))).toBe(true);
    expect(lines.some((l) => l.includes('300100'))).toBe(true);
  });

  it('corrected=true 加 * 角标', () => {
    const lines = formatLimitUpLadderLines(
      baseLadder({
        total: 1,
        maxLevel: 1,
        levels: [
          {
            level: 1,
            name: '首板',
            count: 1,
            stocks: [
              {
                code: '600003',
                name: '触板股',
                industry: 'TMT',
                ladderLevel: 1,
                uncategorized: false,
                firstTime: null,
                finalTime: null,
                reason: '--',
                price: 10.85,
                rawClose: 10.99,
                corrected: true,
                changePct: 0.099,
                limitUpDate: '2026-07-25',
                board: 'main_board',
              },
            ],
          },
        ],
      }),
    );
    expect(lines.some((l) => l.includes('10.85*'))).toBe(true);
  });

  it('time 缺失显示 --', () => {
    const lines = formatLimitUpLadderLines(
      baseLadder({
        total: 1,
        maxLevel: 1,
        levels: [
          {
            level: 1,
            name: '首板',
            count: 1,
            stocks: [
              {
                code: '600004',
                name: '无名',
                industry: '--',
                ladderLevel: 1,
                uncategorized: true,
                firstTime: null,
                finalTime: null,
                reason: '',
                price: 5.0,
                rawClose: 5.0,
                corrected: false,
                changePct: 0.05,
                limitUpDate: '2026-07-25',
                board: 'main_board',
              },
            ],
          },
        ],
      }),
    );
    expect(lines.some((l) => l.includes('first --'))).toBe(true);
    expect(lines.some((l) => l.includes('final --'))).toBe(true);
  });
});
