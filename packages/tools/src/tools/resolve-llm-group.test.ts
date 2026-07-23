import type { LLMAdapterLike, ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { resolveLlmGroupTool } from './resolve-llm-group.js';

/** 覆盖 ctx.adapters.llm（ToolContext 字段 readonly，整体替换 adapters 投影）。 */
const withLlm = (ctx: ToolContext, llm: LLMAdapterLike): ToolContext => ({
  ...ctx,
  adapters: { ...ctx.adapters, llm },
});

describe('resolve_llm_group', () => {
  it('mock LLM：从候选里产出成员，全部通过存在性校验', async () => {
    const ctx = await buildMockContext();
    const r = await resolveLlmGroupTool.execute({ prompt: '选出龙头', maxMembers: 3 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.members.length).toBeGreaterThan(0);
    expect(r.data.members.length).toBeLessThanOrEqual(3);
    expect(r.data.dropped).toEqual([]);
    for (const m of r.data.members) {
      expect(await ctx.repos.stock.findById(m.stockId)).not.toBeNull();
      expect(m.reason.length).toBeGreaterThan(0);
    }
  });

  it('LLM 返回不存在的 stockId → 丢弃进 dropped；不存在的全部丢弃后 members 为空', async () => {
    const ctx = await buildMockContext();
    const stub: LLMAdapterLike = {
      name: 'stub-llm',
      generate: <T>() =>
        Promise.resolve({
          members: [
            { stockId: '002594.SZ', rationale: '真股票' },
            { stockId: '999999.XX', rationale: '假股票' },
            { stockId: '002594.SZ', rationale: '重复' },
          ],
        } as T),
    };
    const r = await resolveLlmGroupTool.execute({ prompt: 'x' }, withLlm(ctx, stub));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.members).toEqual([{ stockId: '002594.SZ', reason: '真股票' }]);
    expect(r.data.dropped).toEqual(['999999.XX']);
    expect(r.data.rawCount).toBe(3);
  });

  it('截断到 maxMembers', async () => {
    const ctx = await buildMockContext();
    const stub: LLMAdapterLike = {
      name: 'stub-llm',
      generate: <T>() =>
        Promise.resolve({
          members: [
            { stockId: '002594.SZ', rationale: 'a' },
            { stockId: '600519.SH', rationale: 'b' },
            { stockId: '300750.SZ', rationale: 'c' },
          ],
        } as T),
    };
    const r = await resolveLlmGroupTool.execute({ prompt: 'x', maxMembers: 2 }, withLlm(ctx, stub));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.members.map((m) => m.stockId)).toEqual(['002594.SZ', '600519.SH']);
  });

  it('LLM 调用抛异常 → llm_error（retryable）', async () => {
    const ctx = await buildMockContext();
    const stub: LLMAdapterLike = {
      name: 'stub-llm',
      generate: () => Promise.reject(new Error('boom')),
    };
    const r = await resolveLlmGroupTool.execute({ prompt: 'x' }, withLlm(ctx, stub));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('llm_error');
    if (r.error.kind === 'llm_error') {
      expect(r.error.retryable).toBe(true);
    }
  });

  it('LLM 输出未通过 schema 校验 → llm_error（retryable=false）', async () => {
    const ctx = await buildMockContext();
    const stub: LLMAdapterLike = {
      name: 'stub-llm',
      generate: <T>() => Promise.resolve({ garbage: true } as T),
    };
    const r = await resolveLlmGroupTool.execute({ prompt: 'x' }, withLlm(ctx, stub));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('llm_error');
    if (r.error.kind === 'llm_error') {
      expect(r.error.retryable).toBe(false);
    }
  });
});
