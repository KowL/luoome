import { describe, expect, it } from 'vitest';

import {
  AiSourceTraceSchema,
  assertStrategySelectionPolicy,
  STRATEGY_WATCHLIST_LEGACY_POLICY,
  StrategyDefinitionRuntimeSourceSchema,
  stageAfterAutomaticSourceEntry,
} from './strategy-watchlist-policy.js';

describe('Strategy / Watchlist 已确认决策约束', () => {
  it('运行时 definition 唯一接受 canonical JSON 身份', () => {
    expect(StrategyDefinitionRuntimeSourceSchema.parse('canonical-json')).toBe('canonical-json');
    expect(StrategyDefinitionRuntimeSourceSchema.safeParse('yaml').success).toBe(false);
  });

  it('archived Member 收到自动来源时恢复 discovered', () => {
    expect(stageAfterAutomaticSourceEntry('archived')).toBe('discovered');
    expect(stageAfterAutomaticSourceEntry('researching')).toBe('researching');
  });

  it('AI source 复用 chat/tool trace，不允许无审计关联', () => {
    expect(AiSourceTraceSchema.parse({ chatMessageId: 'msg-1' })).toEqual({
      chatMessageId: 'msg-1',
    });
    expect(AiSourceTraceSchema.safeParse({}).success).toBe(false);
  });

  it('legacy 只保留两个发布版本且切换后单写目标模型', () => {
    expect(STRATEGY_WATCHLIST_LEGACY_POLICY).toEqual({
      deprecatedRelease: 'N',
      removedByDefaultRelease: 'N+1',
      legacyTablesReadOnlyUntil: 'N+2',
      writeModeAfterSwitch: 'translate-to-target',
    });
  });

  it('零 selection rule 只允许 builtin/migration', () => {
    expect(() =>
      assertStrategySelectionPolicy({ origin: 'builtin', selectionRuleCount: 0 }),
    ).not.toThrow();
    expect(() =>
      assertStrategySelectionPolicy({ origin: 'migration', selectionRuleCount: 0 }),
    ).not.toThrow();
    expect(() => assertStrategySelectionPolicy({ origin: 'user', selectionRuleCount: 0 })).toThrow(
      /至少需要一条/,
    );
    expect(() =>
      assertStrategySelectionPolicy({ origin: 'user', selectionRuleCount: 1 }),
    ).not.toThrow();
  });
});
