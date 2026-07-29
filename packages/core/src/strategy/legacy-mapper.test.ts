import { describe, expect, it } from 'vitest';

import type { Tactic, TacticSignal } from '../entity/tactic.js';
import { mapLegacyTacticSignal, mapLegacyTacticToStrategy } from './legacy-mapper.js';

const T = new Date('2026-07-01T00:00:00.000Z');

const tactic = (overrides: Partial<Tactic> = {}): Tactic => ({
  id: 'legacy-tactic',
  name: 'Legacy',
  tag: 'momentum',
  description: 'legacy tactic',
  triggerWhen: 'indicators.close > indicators.ma20',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Strategy score placeholder
  scoreExpression: 'Math.min(100, ${indicators.rsi14})',
  direction: 'bullish',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Strategy evidence placeholder
  evidenceTemplate: ['RSI=${indicators.rsi14}'],
  source: 'builtin',
  definedAt: T,
  ...overrides,
});

describe('mapLegacyTacticToStrategy', () => {
  it('signalBucket：risk tag → risk，bearish → exit，其余 → entry', () => {
    const risk = mapLegacyTacticToStrategy(tactic({ tag: 'risk', direction: 'bearish' }));
    expect(risk.version.definition.signals.risk[0]?.id).toBe('legacy-signal');
    expect(risk.version.definition.signals.entry).toEqual([]);
    expect(risk.version.definition.signals.exit).toEqual([]);

    const exit = mapLegacyTacticToStrategy(tactic({ direction: 'bearish' }));
    expect(exit.version.definition.signals.exit[0]?.id).toBe('legacy-signal');
    expect(exit.version.definition.signals.entry).toEqual([]);

    const entry = mapLegacyTacticToStrategy(tactic({ direction: 'neutral' }));
    expect(entry.version.definition.signals.entry[0]?.id).toBe('legacy-signal');
    expect(entry.version.definition.signals.exit).toEqual([]);
  });

  it('表达式与字段都合法 → valid + publishedAt', () => {
    const bundle = mapLegacyTacticToStrategy(tactic());
    expect(bundle.version.validationStatus).toBe('valid');
    expect(bundle.version.validationErrors).toEqual([]);
    expect(bundle.version.publishedAt).toEqual(T);
  });

  it('triggerWhen 语法非法 → invalid 且不签 publishedAt', () => {
    const bundle = mapLegacyTacticToStrategy(tactic({ triggerWhen: 'quote.close >' }));
    expect(bundle.version.validationStatus).toBe('invalid');
    expect(bundle.version.validationErrors[0]).toContain('signal.legacy-signal.when 表达式无效');
    expect(bundle.version.publishedAt).toBeUndefined();
  });

  it('引用未注册字段 → invalid 且不签 publishedAt', () => {
    const bundle = mapLegacyTacticToStrategy(tactic({ triggerWhen: 'fundamentals.roe > 0.1' }));
    expect(bundle.version.validationStatus).toBe('invalid');
    expect(bundle.version.validationErrors).toContain('未注册的 Strategy 字段: fundamentals.roe');
    expect(bundle.version.publishedAt).toBeUndefined();
  });
});

describe('mapLegacyTacticSignal', () => {
  it('映射 legacy signal 字段并保留 evaluationSnapshot', () => {
    const signal: TacticSignal = {
      tacticId: 'legacy-tactic',
      tacticName: 'Legacy',
      tacticTag: 'momentum',
      stockId: '600519.SH',
      ts: T,
      score: 75,
      direction: 'bullish',
      evidence: ['RSI=63'],
      triggerSnapshot: { expression: 'true', result: true },
    };
    const mapped = mapLegacyTacticSignal(signal, {
      id: 'signal-1',
      strategyId: 'legacy-tactic',
      strategyVersionId: 'legacy-tactic-v1',
      runId: 'run-1',
    });
    expect(mapped).toEqual({
      id: 'signal-1',
      strategyId: 'legacy-tactic',
      strategyVersionId: 'legacy-tactic-v1',
      runId: 'run-1',
      ruleId: 'legacy-signal',
      stockId: '600519.SH',
      ts: T,
      score: 75,
      direction: 'bullish',
      evidence: ['RSI=63'],
      evaluationSnapshot: { expression: 'true', result: true },
    });
  });
});
