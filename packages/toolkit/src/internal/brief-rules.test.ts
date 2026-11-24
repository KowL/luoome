import { isRuleFallbackAdvice, STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import {
  type BriefPreScreenAction,
  type BriefPreScreenInput,
  type BriefPriority,
  type BriefStrategySignal,
  buildRuleOnlyDraft,
  DEFAULT_STALE_FACT_DAYS,
  preScreenStockBrief,
  RULE_ONLY_MAX_CONFIDENCE,
} from './brief-rules.js';

const TRADING_DATE = '2026-11-24';
const TODAY_SIGNAL_TS = new Date('2026-11-24T03:00:00.000Z');
const YESTERDAY_SIGNAL_TS = new Date('2026-11-23T03:00:00.000Z');
const BANNED_ACTION_WORDS = ['建仓', '加仓', '减仓', '清仓', '买入', '卖出'];

const baseInput = (overrides: Partial<BriefPreScreenInput> = {}): BriefPreScreenInput => ({
  tradingDate: TRADING_DATE,
  stockId: '600519.SH',
  stockName: '贵州茅台',
  held: false,
  watchlistStage: null,
  facts: {
    factDigest: 'digest-current',
    quoteAvailable: true,
    barsAvailable: true,
  },
  ...overrides,
});

const todaySignal = (
  score: number,
  direction: 'bullish' | 'bearish' | 'neutral' = 'bullish',
): readonly BriefStrategySignal[] => [{ score, direction, ts: TODAY_SIGNAL_TS }];

describe('preScreenStockBrief priority table', () => {
  const cases: readonly {
    name: string;
    input: BriefPreScreenInput;
    priority: BriefPriority;
    action: BriefPreScreenAction;
  }[] = [
    {
      name: 'P0 持仓即使同时 watching 也进入 LLM',
      input: baseInput({ held: true, watchlistStage: 'watching' }),
      priority: 'P0',
      action: 'include',
    },
    {
      name: 'P1 confirmed 进入 LLM',
      input: baseInput({ watchlistStage: 'confirmed' }),
      priority: 'P1',
      action: 'include',
    },
    {
      name: 'P1 researching 进入 LLM',
      input: baseInput({ watchlistStage: 'researching' }),
      priority: 'P1',
      action: 'include',
    },
    {
      name: 'P2 当日 60 分信号进入 LLM',
      input: baseInput({ strategySignals: todaySignal(60) }),
      priority: 'P2',
      action: 'include',
    },
    {
      name: 'P3 watching 非持仓一律规则观察',
      input: baseInput({ watchlistStage: 'watching' }),
      priority: 'P3',
      action: 'rule-only',
    },
    {
      name: 'P4 其余候选使用规则观察',
      input: baseInput(),
      priority: 'P4',
      action: 'rule-only',
    },
  ];

  it.each(cases)('$name', ({ input, priority, action }) => {
    const result = preScreenStockBrief(input);
    expect(result.priority).toBe(priority);
    expect(result.action).toBe(action);
  });
});

describe('preScreenStockBrief exclusions', () => {
  it('skips same-day unchanged factDigest with zero LLM', () => {
    const result = preScreenStockBrief(
      baseInput({
        existingBrief: { digest: 'digest-current', decision: 'watch' },
      }),
    );
    expect(result.action).toBe('skip');
    expect(result.reason).toContain('0 次 LLM');
  });

  it('skips after N days without new facts and keeps N configurable', () => {
    const stale = baseInput({
      existingBrief: { digest: 'digest-previous', decision: 'watch' },
      consecutiveNoNewFactDays: DEFAULT_STALE_FACT_DAYS,
    });
    expect(preScreenStockBrief(stale).action).toBe('skip');

    const longerWindow = preScreenStockBrief({ ...stale, staleAfterDays: 5 });
    expect(longerWindow.action).toBe('rule-only');

    const shorterWindow = preScreenStockBrief({ ...stale, staleAfterDays: 2 });
    expect(shorterWindow.action).toBe('skip');
  });

  it('excludes suspended and delisted stocks with reasons', () => {
    const suspended = preScreenStockBrief(baseInput({ listingStatus: 'suspended' }));
    expect(suspended.action).toBe('unavailable');
    expect(suspended.reason).toContain('停牌');

    const delisted = preScreenStockBrief(baseInput({ listingStatus: 'delisted' }));
    expect(delisted.action).toBe('skip');
    expect(delisted.reason).toContain('退市');
  });

  it('marks quote unavailable as unavailable with a reason', () => {
    const result = preScreenStockBrief(
      baseInput({
        facts: { factDigest: 'digest-current', quoteAvailable: false, barsAvailable: true },
      }),
    );
    expect(result.action).toBe('unavailable');
    expect(result.reason).toContain('报价');
  });

  it('does not promote yesterday or sub-threshold signals to P2', () => {
    const yesterday = preScreenStockBrief(
      baseInput({
        strategySignals: [{ score: 80, direction: 'bullish', ts: YESTERDAY_SIGNAL_TS }],
      }),
    );
    expect(yesterday.priority).toBe('P4');
    expect(yesterday.action).toBe('rule-only');

    const lowScore = preScreenStockBrief(baseInput({ strategySignals: todaySignal(59) }));
    expect(lowScore.priority).toBe('P4');
    expect(lowScore.action).toBe('rule-only');
  });
});

describe('buildRuleOnlyDraft', () => {
  const assertRuleOnlyDraft = (input: BriefPreScreenInput) => {
    const result = preScreenStockBrief(input);
    expect(result.action).toBe('rule-only');
    const draft = result.ruleOnly;
    expect(draft).toBeDefined();
    if (draft === undefined) return;
    expect(['hold', 'watch', 'avoid']).toContain(draft.decision);
    expect(draft.confidence).toBeLessThanOrEqual(RULE_ONLY_MAX_CONFIDENCE);
    for (const disclaimer of STANDARD_DISCLAIMERS) {
      expect(draft.disclaimers).toContain(disclaimer);
    }
    expect(
      isRuleFallbackAdvice({
        reasoning: {
          premise: draft.premise,
          evidence: [...draft.evidence],
          counterEvidence: [],
        },
      }),
    ).toBe(true);
    for (const banned of BANNED_ACTION_WORDS) {
      expect(draft.premise).not.toContain(banned);
      expect(draft.evidence.join('；')).not.toContain(banned);
    }
  };

  it('produces hold/watch/avoid-only deterministic drafts without action verbs', () => {
    assertRuleOnlyDraft(baseInput({ watchlistStage: 'watching' }));
    assertRuleOnlyDraft(
      baseInput({ strategySignals: [{ score: 50, direction: 'bearish', ts: TODAY_SIGNAL_TS }] }),
    );
    assertRuleOnlyDraft(baseInput());
  });

  it('uses neutral observation for a held stock when explicitly drafted', () => {
    const draft = buildRuleOnlyDraft(baseInput({ held: true, watchlistStage: 'confirmed' }), []);
    expect(draft.decision).toBe('hold');
    expect(draft.premise).toContain('中性观察');
    expect(draft.confidence).toBeLessThanOrEqual(RULE_ONLY_MAX_CONFIDENCE);
  });

  it('records missing dimensions in evidence', () => {
    const draft = buildRuleOnlyDraft(
      baseInput({
        facts: {
          factDigest: 'digest-current',
          quoteAvailable: true,
          barsAvailable: false,
          missingDimensions: ['daily-bars', 'news'],
        },
      }),
      [],
    );
    expect(draft.evidence.join('；')).toContain('daily-bars');
    expect(draft.evidence.join('；')).toContain('news');
  });
});
