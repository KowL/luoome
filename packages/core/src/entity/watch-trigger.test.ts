import { describe, expect, it } from 'vitest';

import { money } from '../types/branded.js';
import {
  assertWatchTriggerInvariants,
  CostThresholdRuleSchema,
  PriceChangeRuleSchema,
  PriceLevelRuleSchema,
  WatchTriggerSchema,
} from './watch-trigger.js';

const NOW = new Date('2026-07-21T02:00:00.000Z');

describe('AlertPlan 共享规则 schema', () => {
  it('cost-threshold stopLoss + takeProfit 都缺 → parse 失败', () => {
    const r = CostThresholdRuleSchema.safeParse({ kind: 'cost-threshold' });
    expect(r.success).toBe(false);
  });

  it('price-change pct=0 → parse 失败（必须 > 0）', () => {
    const r = PriceChangeRuleSchema.safeParse({ kind: 'price-change', pct: 0 });
    expect(r.success).toBe(false);
  });

  it('price-change 缺 direction → 默认 any', () => {
    const r = PriceChangeRuleSchema.parse({ kind: 'price-change', pct: 0.05 });
    expect(r.direction).toBe('any');
  });

  it('price-level level=0 → parse 失败（必须 > 0）', () => {
    const r = PriceLevelRuleSchema.safeParse({ kind: 'price-level', level: 0, side: 'above' });
    expect(r.success).toBe(false);
  });

  it('price-level side 非法 → parse 失败', () => {
    const r = PriceLevelRuleSchema.safeParse({ kind: 'price-level', level: 10, side: 'middle' });
    expect(r.success).toBe(false);
  });

  it('rule 接受可选 id 与 priority（v0.7 字段）', () => {
    const r = PriceChangeRuleSchema.parse({
      kind: 'price-change',
      pct: 0.05,
      id: 'r_abc',
      priority: 'important',
    });
    expect(r.id).toBe('r_abc');
    expect(r.priority).toBe('important');
  });
});

describe('WatchTrigger schema', () => {
  const minimalTrigger = () => ({
    id: 't-1',
    poolId: 'holdings-watch',
    stockId: '002594.SZ',
    ruleKind: 'price-change' as const,
    ruleId: 'r_abc',
    triggerType: 'triggered' as const,
    direction: 'watch' as const,
    priority: 'normal' as const,
    deliveryStatus: 'sent' as const,
    evalSnapshot: { ruleId: 'r_abc', kind: 'price-change' },
    reason: '日内涨幅 5.2%',
    evidence: ['close=15.2 prevClose=14.5'],
    quote: { close: 15.2, ts: NOW },
    notified: true,
    createdAt: NOW,
  });

  it('合法 trigger parse 通过', () => {
    const r = WatchTriggerSchema.safeParse(minimalTrigger());
    expect(r.success).toBe(true);
  });

  it('存量 ruleKind=tactic 行可读兼容', () => {
    const r = WatchTriggerSchema.safeParse({ ...minimalTrigger(), ruleKind: 'tactic' });
    expect(r.success).toBe(true);
  });

  it('triggerType 缺省时为 triggered', () => {
    const { triggerType: _omitted, ...rest } = minimalTrigger();
    void _omitted;
    const r = WatchTriggerSchema.parse(rest);
    expect(r.triggerType).toBe('triggered');
  });

  it('direction 非法值 → parse 失败', () => {
    const t = { ...minimalTrigger(), direction: 'moon' as never };
    const r = WatchTriggerSchema.safeParse(t);
    expect(r.success).toBe(false);
  });
});

describe('WatchTrigger invariants', () => {
  const baseTrigger = () => ({
    id: 't-1',
    poolId: 'holdings-watch',
    stockId: '002594.SZ',
    ruleKind: 'price-change' as const,
    ruleId: 'r_abc',
    triggerType: 'triggered' as const,
    direction: 'watch' as const,
    priority: 'normal' as const,
    deliveryStatus: 'sent' as const,
    evalSnapshot: { ruleId: 'r_abc' },
    reason: '日内涨幅 5.2%',
    evidence: ['close=15.2 prevClose=14.5'],
    quote: { close: money(15.2), ts: NOW },
    notified: true,
    createdAt: NOW,
  });

  it('合法 trigger 通过不变量', () => {
    expect(() => assertWatchTriggerInvariants(baseTrigger())).not.toThrow();
  });

  it('quote.close <= 0 → InvariantError', () => {
    expect(() =>
      assertWatchTriggerInvariants({ ...baseTrigger(), quote: { close: money(0), ts: NOW } }),
    ).toThrow(/close/);
  });

  it('evidence 空 → InvariantError', () => {
    expect(() => assertWatchTriggerInvariants({ ...baseTrigger(), evidence: [] })).toThrow(
      /evidence/,
    );
  });
});
