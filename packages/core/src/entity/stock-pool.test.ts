import { describe, expect, it } from 'vitest';

import { money } from '../types/branded.js';
import {
  assertStockPoolInvariants,
  assertWatchTriggerInvariants,
  type StockPool,
  StockPoolSchema,
  WatchRuleSchema,
  WatchTriggerSchema,
} from './stock-pool.js';

const NOW = new Date('2026-07-21T02:00:00.000Z');
const LATER = new Date('2026-07-21T03:00:00.000Z');

const basePool = (overrides: Partial<StockPool> = {}): StockPool => ({
  id: 'holdings-watch',
  name: '持仓监控',
  description: '默认池',
  groupId: 'holdings-default',
  rules: [{ kind: 'price-change', pct: 0.05 }],
  cooldownMinutes: 30,
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('StockPool schema', () => {
  it('合法 tactic 规则可 parse（minScore 缺省 60）', () => {
    const parsed = WatchRuleSchema.parse({ kind: 'tactic', tacticId: 'm1' });
    expect(parsed.kind).toBe('tactic');
    if (parsed.kind === 'tactic') {
      expect(parsed.minScore).toBe(60);
    }
  });

  it('cost-threshold stopLoss + takeProfit 都缺 → parse 失败', () => {
    const r = WatchRuleSchema.safeParse({ kind: 'cost-threshold' });
    expect(r.success).toBe(false);
  });

  it('price-change pct=0 → parse 失败（必须 > 0）', () => {
    const r = WatchRuleSchema.safeParse({ kind: 'price-change', pct: 0 });
    expect(r.success).toBe(false);
  });

  it('id 含大写 → schema parse 失败', () => {
    const r = StockPoolSchema.safeParse(basePool({ id: 'BadID' }));
    expect(r.success).toBe(false);
  });

  it('groupId 引用 + cost-threshold / tactic 规则组合合法', () => {
    const r = StockPoolSchema.safeParse(
      basePool({
        rules: [
          { kind: 'cost-threshold', stopLossPct: 0.05, takeProfitPct: 0.05 },
          { kind: 'tactic', tacticId: 'volume-price-divergence', minScore: 60 },
        ],
      }),
    );
    expect(r.success).toBe(true);
  });
});

describe('StockPool invariants', () => {
  it('formula 分组 tacticId 一致性不在 entity 层断言（跨实体校验归 tool 层，阶段 B）', () => {
    // rules 里 tactic 规则与分组 resolver 是否一致，entity 拿不到 repo 无法判断 → 不抛错
    const pool = basePool({
      groupId: 'some-formula-group',
      rules: [{ kind: 'tactic', tacticId: 'any-tactic', minScore: 60 }],
    });
    expect(() => assertStockPoolInvariants(pool)).not.toThrow();
  });

  it('updatedAt < createdAt → InvariantError', () => {
    const pool = basePool({ createdAt: LATER, updatedAt: NOW });
    expect(() => assertStockPoolInvariants(pool)).toThrow(/updatedAt/);
  });

  it('rules 为空数组 → InvariantError', () => {
    const pool = basePool({ rules: [] });
    expect(() => assertStockPoolInvariants(pool)).toThrow(/rules/);
  });

  it('id 长度越界 → InvariantError', () => {
    const pool = basePool({ id: 'a' });
    expect(() => assertStockPoolInvariants(pool)).toThrow(/id/);
  });
});

describe('WatchTrigger schema', () => {
  it('合法 trigger parse 通过', () => {
    const t = {
      id: 't-1',
      poolId: 'holdings-watch',
      stockId: '002594.SZ',
      ruleKind: 'price-change' as const,
      direction: 'watch' as const,
      reason: '日内涨幅 5.2%',
      evidence: ['close=15.2 prevClose=14.5'],
      quote: { close: 15.2, ts: NOW },
      notified: true,
      createdAt: NOW,
    };
    const r = WatchTriggerSchema.safeParse(t);
    expect(r.success).toBe(true);
  });

  it('direction 非法值 → parse 失败', () => {
    const t = {
      id: 't-1',
      poolId: 'p',
      stockId: 's',
      ruleKind: 'price-change' as const,
      direction: 'moon',
      reason: 'r',
      evidence: ['e'],
      quote: { close: 15.2, ts: NOW },
      notified: true,
      createdAt: NOW,
    };
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
    direction: 'watch' as const,
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
