import { type StrategyDslV1, strategyDefinitionHash, type ToolContext } from '@luoome/core';
import { proposeStrategyVersionDraftTool } from '@luoome/plugin-strategy/tools/strategy-definition.js';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';

const now = new Date('2026-09-02T08:00:00.000Z');

const definition = (when: string): StrategyDslV1 => ({
  schemaVersion: 1,
  metadata: { horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [{ id: 'rule', name: '规则', when, evidence: ['价格'] }],
  },
  signals: { entry: [], exit: [], risk: [] },
});

const seedStrategy = async (ctx: ToolContext): Promise<void> => {
  const baseline = definition('quote.close > 0');
  await ctx.repos.strategy.create({
    id: 'strategy-draft',
    name: '草案测试策略',
    description: '草案测试',
    owner: 'user',
    status: 'active',
    currentVersionId: 'strategy-draft:v1',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.repos.strategy.createVersion({
    id: 'strategy-draft:v1',
    strategyId: 'strategy-draft',
    version: 1,
    definition: baseline,
    definitionHash: strategyDefinitionHash(baseline),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  });
};

const propose = (ctx: ToolContext, when: string) =>
  proposeStrategyVersionDraftTool.execute(
    {
      strategyId: 'strategy-draft',
      definition: definition(when),
      changeSummary: '调整筛选条件',
      factReferences: ['runs:window'],
    },
    ctx,
  );

describe('propose_strategy_version_draft DSL 白名单', () => {
  it.each([
    'ref(quote.close) > 0',
    'ATR(14) > 0',
    'marketIndexChangePct > 1',
    'Number.isFinite(indicators.ma20)',
  ])('非法表达式 %s 返回 invalid_input 并带修复提示', async (when) => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedStrategy(ctx);

    const result = await propose(ctx, when);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    if (result.error.kind !== 'invalid_input') return;
    expect(result.error.message).toContain('修复提示');
    expect(result.error.message).toContain('get_strategy_dsl_catalog');
  });

  it('合法 indicators.ma20 不误杀', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedStrategy(ctx);

    const result = await propose(ctx, 'indicators.ma20 > 0');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.draft.definition.selection.rules[0]?.when).toBe('indicators.ma20 > 0');
  });
});
