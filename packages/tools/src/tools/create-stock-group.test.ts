import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { createStockGroupTool } from './create-stock-group.js';

const MOCK_ACCOUNT_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

describe('create_stock_group', () => {
  it('manual 分组：合法路径 → 落库 + 字段一致', async () => {
    const ctx = await buildMockContext();
    const r = await createStockGroupTool.execute(
      {
        id: 'semiconductor',
        name: '半导体',
        resolver: { kind: 'manual', stockIds: ['002594.SZ', '600519.SH'] },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.group.id).toBe('semiconductor');
    expect(r.data.group.refreshPolicy).toBe('daily');
    expect(r.data.group.enabled).toBe(true);
    const found = await ctx.repos.stockGroup.findById('semiconductor');
    expect(found?.resolver).toEqual({ kind: 'manual', stockIds: ['002594.SZ', '600519.SH'] });
  });

  it('llm 分组：maxMembers 缺省 20 落库', async () => {
    const ctx = await buildMockContext();
    const r = await createStockGroupTool.execute(
      { id: 'leaders', name: '龙头', resolver: { kind: 'llm', prompt: '选出当前龙头' } },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.group.resolver).toEqual({
      kind: 'llm',
      prompt: '选出当前龙头',
      maxMembers: 20,
    });
  });

  it('formula 分组：tactic 存在（内置战法）→ 落库', async () => {
    const ctx = await buildMockContext();
    const r = await createStockGroupTool.execute(
      {
        id: 'breakout-watch',
        name: '放量突破',
        resolver: { kind: 'formula', tacticId: 'breakout-volume', lookbackDays: 5, minScore: 70 },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it('同 id 重复 → invalid_input', async () => {
    const ctx = await buildMockContext();
    const input = {
      id: 'dup-group',
      name: 'x',
      resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
    };
    await createStockGroupTool.execute(input, ctx);
    const r2 = await createStockGroupTool.execute(input, ctx);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe('invalid_input');
  });

  it('formula.tacticId 不存在 → not_found', async () => {
    const ctx = await buildMockContext();
    const r = await createStockGroupTool.execute(
      {
        id: 'bad-tactic',
        name: 'x',
        resolver: { kind: 'formula', tacticId: 'no-such-tactic', lookbackDays: 5 },
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('holdings.accountId 不存在 → not_found', async () => {
    const ctx = await buildMockContext();
    const r = await createStockGroupTool.execute(
      { id: 'bad-account', name: 'x', resolver: { kind: 'holdings', accountId: 'no-such-acc' } },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('holdings.accountId 存在 → 落库', async () => {
    const ctx = await buildMockContext();
    const r = await createStockGroupTool.execute(
      {
        id: 'my-holdings',
        name: '持仓',
        resolver: { kind: 'holdings', accountId: MOCK_ACCOUNT_ID },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it('manual.stockIds 含不存在股票 → not_found', async () => {
    const ctx = await buildMockContext();
    const r = await createStockGroupTool.execute(
      {
        id: 'bad-stock',
        name: 'x',
        resolver: { kind: 'manual', stockIds: ['002594.SZ', '999999.XX'] },
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('llm.prompt 超 2000 字 → invalid_input（zod parse）', async () => {
    const ctx = await buildMockContext();
    const r = await createStockGroupTool.execute(
      { id: 'bad-prompt', name: 'x', resolver: { kind: 'llm', prompt: 'a'.repeat(2001) } },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });
});
