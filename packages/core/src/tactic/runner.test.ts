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

  describe('Vibe trend_timing 映射 golden fixture', () => {
    it('趋势多头且放量突破时由两个既有战法分别产出可共振的 bullish 事实', () => {
      const context = {
        indicators: {
          ...baseIndicators,
          ma5: 13,
          ma10: 11,
          ma20: 10,
          volRatio5_20: 2,
          close: 12,
          high20: 11.8,
        },
      };
      const outcomes = ['ma-bullish-alignment', 'breakout-volume'].map((id) =>
        runTacticForStock(findTactic(id), '002594.SZ', T, context),
      );

      expect(outcomes.every((outcome) => outcome.triggered)).toBe(true);
      expect(
        outcomes.map((outcome) => (outcome.triggered ? outcome.signal.direction : null)),
      ).toEqual(['bullish', 'bullish']);
    });
  });

  describe('Vibe early_breakout 映射', () => {
    it('温和动量、RSI 未超买、量能确认且刚站上 MA20 时生成 bullish 研究信号', () => {
      const outcome = runTacticForStock(findTactic('early-breakout'), '002594.SZ', T, {
        indicators: {
          close: 11,
          ma5: 10.8,
          ma20: 10,
          ma60: 9.5,
          momentum20Pct: 8,
          volRatio5_20: 1.5,
          rsi14: 60,
          maDistance20Pct: 10,
          daysSinceMa20CrossUp: 1,
          daysAboveMa20: 2,
        },
      });

      expect(outcome.triggered).toBe(true);
      if (!outcome.triggered) return;
      expect(outcome.signal.direction).toBe('bullish');
      expect(outcome.signal.evidence.some((item) => item.includes('20日动量'))).toBe(true);
      expect(outcome.signal.evidence.some((item) => item.includes('MA20'))).toBe(true);
    });

    it('RSI 已超买时不把上涨标的误报为早期突破', () => {
      const outcome = runTacticForStock(findTactic('early-breakout'), '002594.SZ', T, {
        indicators: {
          close: 11,
          ma5: 10.8,
          ma20: 10,
          momentum20Pct: 8,
          volRatio5_20: 1.5,
          rsi14: 75,
          maDistance20Pct: 10,
          daysSinceMa20CrossUp: 1,
          daysAboveMa20: 2,
        },
      });

      expect(outcome.triggered).toBe(false);
    });

    it('最新收盘仍在 MA20 下方时不视为刚站上均线', () => {
      const outcome = runTacticForStock(findTactic('early-breakout'), '002594.SZ', T, {
        indicators: {
          close: 9.9,
          ma5: 10.1,
          ma20: 10,
          momentum20Pct: 5,
          volRatio5_20: 1.5,
          rsi14: 55,
          maDistance20Pct: -1,
          daysAboveMa20: 0,
        },
      });

      expect(outcome.triggered).toBe(false);
    });
  });

  describe('Vibe bollinger_band 映射', () => {
    it('长期趋势未破且缩量回撤到 Bollinger 下轨时生成 bullish 均值回复信号', () => {
      const outcome = runTacticForStock(findTactic('bollinger-band'), '002594.SZ', T, {
        indicators: {
          close: 8.5,
          ma20: 10,
          ma60: 8,
          momentum20Pct: -5,
          volRatio5_20: 1.1,
          rsi14: 35,
          maDistance20Pct: -15,
          bollMiddle20: 10,
          bollUpper20: 11.2,
          bollLower20: 8.8,
          bollBandwidth20Pct: 24,
          bollPosition20: -0.125,
        },
      });

      expect(outcome.triggered).toBe(true);
      if (!outcome.triggered) return;
      expect(outcome.signal.direction).toBe('bullish');
      expect(outcome.signal.evidence.some((item) => item.includes('Bollinger下轨'))).toBe(true);
      expect(outcome.signal.evidence.some((item) => item.includes('长期趋势'))).toBe(true);
    });

    it('价格已跌破 MA60 时拒绝把下轨破位误报为均值回复', () => {
      const outcome = runTacticForStock(findTactic('bollinger-band'), '002594.SZ', T, {
        indicators: {
          close: 7.8,
          ma20: 10,
          ma60: 8,
          momentum20Pct: -10,
          volRatio5_20: 1.1,
          rsi14: 30,
          maDistance20Pct: -22,
          bollLower20: 8.2,
          bollPosition20: -0.1,
        },
      });

      expect(outcome.triggered).toBe(false);
    });
  });
});
