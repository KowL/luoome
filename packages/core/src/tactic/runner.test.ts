import { BUILTIN_TACTICS, type Tactic, type TechnicalIndicators } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { runTacticForStock } from './runner.js';

const T = new Date('2026-07-19T00:00:00.000Z');

const baseIndicators: TechnicalIndicators = {
  ma5: 12,
  ma10: 11,
  ma20: 10,
  volMa5: 1500,
  volMa20: 1000,
  volRatio5_20: 1.5,
  close: 11,
  high20: 10.5,
  low20: 9,
};

const findTactic = (id: string): Tactic => {
  const t = BUILTIN_TACTICS.find((x) => x.id === id);
  if (!t) throw new Error(`no builtin tactic ${id}`);
  return t;
};

describe('tactic/runner', () => {
  describe('放量突破 breakout-volume', () => {
    it('量比达标 + 收盘 ≥ 高20 → trigger + score 缩到 100', () => {
      const r = runTacticForStock(findTactic('breakout-volume'), '002594.SZ', T, {
        indicators: { ...baseIndicators, volRatio5_20: 2.5, close: 12, high20: 11 },
      });
      expect(r.triggered).toBe(true);
      if (r.triggered) {
        expect(r.signal.score).toBe(75); // Math.min(100, 2.5*30)
        expect(r.signal.direction).toBe('bullish');
        expect(r.signal.evidence.some((e) => e.includes('volRatio5_20'))).toBe(true);
      }
    });

    it('量比不足 → trigger_false', () => {
      const r = runTacticForStock(findTactic('breakout-volume'), 'x', T, {
        indicators: { ...baseIndicators, volRatio5_20: 1.1 },
      });
      expect(r.triggered).toBe(false);
      if (!r.triggered) expect(r.reason).toBe('trigger_false');
    });

    it('指标缺失 → trigger_false（不抛错）', () => {
      const r = runTacticForStock(findTactic('breakout-volume'), 'x', T, {
        indicators: { ma5: 1 },
      });
      expect(r.triggered).toBe(false);
    });
  });

  describe('均线多头 ma-bullish-alignment', () => {
    it('MA5 > MA10 > MA20 → 触发', () => {
      const r = runTacticForStock(findTactic('ma-bullish-alignment'), 'x', T, {
        indicators: { ...baseIndicators, ma5: 13, ma10: 11, ma20: 10 },
      });
      expect(r.triggered).toBe(true);
    });

    it('MA10 == MA20 → 不触发', () => {
      const r = runTacticForStock(findTactic('ma-bullish-alignment'), 'x', T, {
        indicators: { ...baseIndicators, ma5: 13, ma10: 10, ma20: 10 },
      });
      expect(r.triggered).toBe(false);
    });
  });

  describe('涨停回踩 pullback-after-limit-up', () => {
    it('recentLimitUp=true + 现价 ≥ MA5*0.98 → 触发', () => {
      const r = runTacticForStock(findTactic('pullback-after-limit-up'), 'x', T, {
        indicators: { ...baseIndicators, close: 11.8, ma5: 12 },
        meta: { recentLimitUp: true, daysSinceLimitUp: 3 },
      });
      expect(r.triggered).toBe(true);
      if (r.triggered) {
        // 60 + min(40, 3*5) = 75
        expect(r.signal.score).toBe(75);
      }
    });

    it('未涨停 → 不触发', () => {
      const r = runTacticForStock(findTactic('pullback-after-limit-up'), 'x', T, {
        indicators: { ...baseIndicators },
        meta: { recentLimitUp: false },
      });
      expect(r.triggered).toBe(false);
    });
  });

  describe('量价背离 volume-price-divergence', () => {
    it('上涨 + 量比 ≤ 0.7 → 触发 bearish', () => {
      const r = runTacticForStock(findTactic('volume-price-divergence'), 'x', T, {
        indicators: { ...baseIndicators, volRatio5_20: 0.5 },
        meta: { priceUp: true },
      });
      expect(r.triggered).toBe(true);
      if (r.triggered) expect(r.signal.direction).toBe('bearish');
    });

    it('放量 + 上涨 → 不触发', () => {
      const r = runTacticForStock(findTactic('volume-price-divergence'), 'x', T, {
        indicators: { ...baseIndicators, volRatio5_20: 1.2 },
        meta: { priceUp: true },
      });
      expect(r.triggered).toBe(false);
    });
  });

  describe('板块共振 sector-resonance', () => {
    it('板块 + 个股双涨 → 触发', () => {
      const r = runTacticForStock(findTactic('sector-resonance'), 'x', T, {
        indicators: { ...baseIndicators },
        meta: { sectorAvgChange3d: 0.025, stockChange3d: 0.02 },
      });
      expect(r.triggered).toBe(true);
    });

    it('板块没涨 → 不触发', () => {
      const r = runTacticForStock(findTactic('sector-resonance'), 'x', T, {
        indicators: { ...baseIndicators },
        meta: { sectorAvgChange3d: 0.005, stockChange3d: 0.02 },
      });
      expect(r.triggered).toBe(false);
    });
  });

  describe('信号结构', () => {
    it('signal 包含 tacticName + tacticTag + triggerSnapshot', () => {
      const r = runTacticForStock(findTactic('ma-bullish-alignment'), 'x', T, {
        indicators: { ...baseIndicators, ma5: 13, ma10: 11, ma20: 10 },
      });
      expect(r.triggered).toBe(true);
      if (r.triggered) {
        expect(r.signal.tacticName).toBe('均线多头');
        expect(r.signal.tacticTag).toBe('momentum');
        expect(r.signal.triggerSnapshot?.expression).toBeTruthy();
        expect(r.signal.triggerSnapshot?.result).toBe(true);
      }
    });
  });
});
