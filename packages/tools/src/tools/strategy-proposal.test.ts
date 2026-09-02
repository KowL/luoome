import { type StrategyDslV1, strategyDefinitionHash, type ToolContext } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { generateStrategyVersionProposalTool } from './strategy-proposal.js';

const now = new Date('2026-09-02T08:00:00.000Z');

const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: { style: 'quality', horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [{ id: 'quality', name: '质量门槛', when: 'quote.close > 10', evidence: ['收盘价'] }],
  },
  signals: { entry: [], exit: [], risk: [] },
};

const seedStrategy = async (
  ctx: ToolContext,
  options: { readonly owner?: 'builtin' | 'user'; readonly description?: string } = {},
): Promise<void> => {
  await ctx.repos.strategy.create({
    id: 'strategy-1',
    name: '提议测试策略',
    description: options.description ?? '提议测试',
    owner: options.owner ?? 'user',
    status: 'active',
    currentVersionId: 'strategy-1:v1',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.repos.strategy.createVersion({
    id: 'strategy-1:v1',
    strategyId: 'strategy-1',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  });
};

describe('generate_strategy_version_proposal', () => {
  it('默认输出：基线规则追加收敛条件，hash 变化，factReferences 来自事实集', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedStrategy(ctx);

    const result = await generateStrategyVersionProposalTool.execute(
      { strategyId: 'strategy-1' },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: { proposed: true, provider: 'fake-llm' },
    });
    if (!result.ok || !result.data.proposed) return;
    expect(result.data.proposal.definitionHash).not.toBe(strategyDefinitionHash(definition));
    expect(result.data.proposal.definition.selection.rules[0]?.when).toBe(
      'quote.close > 10 && quote.close > 0',
    );
    expect(result.data.proposal.factReferences).toEqual(['runs:window']);
  });

  it('builtin Strategy 拒绝提议', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedStrategy(ctx, { owner: 'builtin' });

    const result = await generateStrategyVersionProposalTool.execute(
      { strategyId: 'strategy-1' },
      ctx,
    );

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });

  it('缺少 currentVersion 基线时拒绝', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await ctx.repos.strategy.create({
      id: 'strategy-no-base',
      name: '无基线策略',
      description: 'draft',
      owner: 'user',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });

    const result = await generateStrategyVersionProposalTool.execute(
      { strategyId: 'strategy-no-base' },
      ctx,
    );

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });

  it('LLM 调用抛错 → adapter_error（可重试），由 workflow 当周跳过', async () => {
    const base = await buildTestContext({ clock: () => now });
    await seedStrategy(base);
    const ctx: ToolContext = {
      ...base,
      adapters: {
        ...base.adapters,
        llm: {
          name: 'offline-llm',
          generate: async <T>() => Promise.reject<T>(new Error('provider unavailable')),
        },
      },
    };

    const result = await generateStrategyVersionProposalTool.execute(
      { strategyId: 'strategy-1' },
      ctx,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'adapter_error', adapter: 'offline-llm', recoverable: true },
    });
  });

  it('输出不过 schema → proposed=false + invalid-output', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedStrategy(ctx, { description: 'proposal-fixture:schema-error' });

    const result = await generateStrategyVersionProposalTool.execute(
      { strategyId: 'strategy-1' },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: { proposed: false, reasonCode: 'invalid-output' },
    });
  });

  it('提议与基线定义一致 → proposed=false + unchanged', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedStrategy(ctx, { description: 'proposal-fixture:unchanged' });

    const result = await generateStrategyVersionProposalTool.execute(
      { strategyId: 'strategy-1' },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: { proposed: false, reasonCode: 'unchanged' },
    });
  });

  it('factReferences 引用不存在的事实 → proposed=false + invalid-output', async () => {
    const base = await buildTestContext({ clock: () => now });
    await seedStrategy(base);
    const ctx: ToolContext = {
      ...base,
      adapters: {
        ...base.adapters,
        llm: {
          name: 'bad-ref-llm',
          generate: async <T>() =>
            ({
              definition,
              changeSummary: '引用伪造事实',
              factReferences: ['fact:not-exist'],
            }) as T,
        },
      },
    };

    const result = await generateStrategyVersionProposalTool.execute(
      { strategyId: 'strategy-1' },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: { proposed: false, reasonCode: 'invalid-output' },
    });
    if (!result.ok || result.data.proposed) return;
    expect(result.data.reason).toContain('fact:not-exist');
  });
});
