import { describe, expect, it } from 'vitest';

import {
  assertStockGroupInvariants,
  GroupMemberSnapshotSchema,
  type GroupResolver,
  GroupResolverSchema,
  type StockGroup,
  StockGroupSchema,
} from './stock-group.js';

const NOW = new Date('2026-07-22T02:00:00.000Z');
const LATER = new Date('2026-07-22T03:00:00.000Z');

const baseGroup = (overrides: Partial<StockGroup> = {}): StockGroup => ({
  id: 'semiconductor',
  name: '半导体',
  description: '手动维护的半导体板块',
  resolver: { kind: 'manual', stockIds: ['002594.SZ', '600519.SH'] },
  refreshPolicy: 'manual',
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('StockGroup schema', () => {
  it('四种 resolver 都可 parse（manual / holdings / formula / llm）', () => {
    const resolvers: GroupResolver[] = [
      { kind: 'manual', stockIds: ['002594.SZ'] },
      { kind: 'holdings', accountId: 'acc-1' },
      { kind: 'formula', tacticId: 'breakout-volume', lookbackDays: 5 },
      { kind: 'llm', prompt: '选出当前龙头', maxMembers: 20 },
    ];
    for (const resolver of resolvers) {
      const r = StockGroupSchema.safeParse(baseGroup({ resolver }));
      expect(r.success).toBe(true);
    }
  });

  it('strategy kind 不在 union 中（预留不实现）→ parse 失败', () => {
    const r = GroupResolverSchema.safeParse({ kind: 'strategy', foo: 1 });
    expect(r.success).toBe(false);
  });

  it('llm resolver：maxMembers 缺省 20；prompt 空 / 超 2000 → 失败', () => {
    const parsed = GroupResolverSchema.parse({ kind: 'llm', prompt: 'x' });
    expect(parsed.kind).toBe('llm');
    if (parsed.kind === 'llm') {
      expect(parsed.maxMembers).toBe(20);
    }
    expect(GroupResolverSchema.safeParse({ kind: 'llm', prompt: '' }).success).toBe(false);
    expect(GroupResolverSchema.safeParse({ kind: 'llm', prompt: 'x'.repeat(2001) }).success).toBe(
      false,
    );
    expect(GroupResolverSchema.safeParse({ kind: 'llm', prompt: 'x', maxMembers: 0 }).success).toBe(
      false,
    );
    expect(
      GroupResolverSchema.safeParse({ kind: 'llm', prompt: 'x', maxMembers: 101 }).success,
    ).toBe(false);
  });

  it('formula resolver：lookbackDays 必须正整数 ≤ 365', () => {
    expect(
      GroupResolverSchema.safeParse({ kind: 'formula', tacticId: 't', lookbackDays: 0 }).success,
    ).toBe(false);
    expect(
      GroupResolverSchema.safeParse({ kind: 'formula', tacticId: 't', lookbackDays: 366 }).success,
    ).toBe(false);
  });

  it('manual resolver：stockIds 空数组 → parse 失败', () => {
    const r = GroupResolverSchema.safeParse({ kind: 'manual', stockIds: [] });
    expect(r.success).toBe(false);
  });

  it('id 含大写 → schema parse 失败', () => {
    const r = StockGroupSchema.safeParse(baseGroup({ id: 'BadID' }));
    expect(r.success).toBe(false);
  });

  it('refreshPolicy / enabled 缺省 daily / true', () => {
    const { refreshPolicy: _rp, enabled: _en, ...rest } = baseGroup();
    const parsed = StockGroupSchema.parse(rest);
    expect(parsed.refreshPolicy).toBe('daily');
    expect(parsed.enabled).toBe(true);
  });
});

describe('StockGroup invariants', () => {
  it('合法分组通过不变量', () => {
    expect(() => assertStockGroupInvariants(baseGroup())).not.toThrow();
  });

  it('updatedAt < createdAt → InvariantError', () => {
    expect(() =>
      assertStockGroupInvariants(baseGroup({ createdAt: LATER, updatedAt: NOW })),
    ).toThrow(/updatedAt/);
  });

  it('id 长度越界 → InvariantError', () => {
    expect(() => assertStockGroupInvariants(baseGroup({ id: 'a' }))).toThrow(/id/);
  });
});

describe('GroupMemberSnapshot schema', () => {
  const baseSnapshot = {
    id: 'snap-1',
    groupId: 'semiconductor',
    stockId: '002594.SZ',
    refreshId: 'rf-2026-07-22',
    reason: '战法 breakout-volume 命中，score=82',
    createdAt: NOW,
  };

  it('合法快照 parse 通过', () => {
    const r = GroupMemberSnapshotSchema.safeParse(baseSnapshot);
    expect(r.success).toBe(true);
  });

  it('refreshId / reason 为空 → parse 失败', () => {
    expect(GroupMemberSnapshotSchema.safeParse({ ...baseSnapshot, refreshId: '' }).success).toBe(
      false,
    );
    expect(GroupMemberSnapshotSchema.safeParse({ ...baseSnapshot, reason: '' }).success).toBe(
      false,
    );
  });
});
