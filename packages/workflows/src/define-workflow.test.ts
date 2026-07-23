import { InvariantError } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineWorkflow } from './define-workflow.js';

describe('defineWorkflow 引擎', () => {
  it('步骤顺序执行：每步收到上一步输出，末步输出即 workflow 输出', async () => {
    const ctx = await buildTestContext();
    const seen: unknown[] = [];
    const wf = defineWorkflow<{ seed: number }, number>({
      name: 'chain-test',
      description: '链式传递',
      input: z.object({ seed: z.number() }),
      steps: [
        (prev) => {
          seen.push(prev);
          return (prev as { seed: number }).seed + 1;
        },
        (prev) => {
          seen.push(prev);
          return (prev as number) * 2;
        },
      ],
    });

    const result = await wf.run({ seed: 1 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(4); // (1 + 1) * 2
    expect(seen).toEqual([{ seed: 1 }, 2]); // 首步收到已校验入参，次步收到上一步输出
  });

  it('步骤返回 ToolResult ok → 自动解包 data 传给下一步（ctx.tools 访问器可用）', async () => {
    const ctx = await buildTestContext();
    const wf = defineWorkflow<Record<string, never>, string>({
      name: 'unwrap-test',
      description: 'ToolResult 自动解包',
      input: z.object({}),
      steps: [
        (_prev, ctx) => ctx.tools.list_holdings.execute({}),
        (prev) => (prev as { accountId: string }).accountId,
      ],
    });

    const result = await wf.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(ctx.user.defaultAccountId);
  });

  it('步骤返回 ToolResult error → 原样短路，后续步骤不执行', async () => {
    const ctx = await buildTestContext();
    let reached = false;
    const wf = defineWorkflow<{ accountId: string }, unknown>({
      name: 'short-circuit-test',
      description: '错误短路',
      input: z.object({ accountId: z.string().min(1) }),
      steps: [
        (prev, ctx) =>
          ctx.tools.list_holdings.execute({
            accountId: (prev as { accountId: string }).accountId,
          }),
        () => {
          reached = true;
          return null;
        },
      ],
    });

    const result = await wf.run({ accountId: 'no-such-account' }, ctx);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Account', id: 'no-such-account' },
    });
    expect(reached).toBe(false);
  });

  it('步骤抛 InvariantError → invariant_violation；抛其他异常 → internal（run 均不 throw）', async () => {
    const ctx = await buildTestContext();
    const invariantWf = defineWorkflow<Record<string, never>, unknown>({
      name: 'invariant-test',
      description: 'InvariantError 映射',
      input: z.object({}),
      steps: [
        () => {
          throw new InvariantError('holding.quantity 必须为正');
        },
      ],
    });
    const invariantResult = await invariantWf.run({}, ctx);
    expect(invariantResult).toEqual({
      ok: false,
      error: { kind: 'invariant_violation', message: 'holding.quantity 必须为正' },
    });

    const boomWf = defineWorkflow<Record<string, never>, unknown>({
      name: 'boom-test',
      description: '未预期异常映射',
      input: z.object({}),
      steps: [
        () => {
          throw new Error('boom');
        },
      ],
    });
    const boomResult = await boomWf.run({}, ctx);
    expect(boomResult.ok).toBe(false);
    if (boomResult.ok) return;
    expect(boomResult.error.kind).toBe('internal');
    if (boomResult.error.kind === 'internal') {
      expect(boomResult.error.cause).toContain('workflow "boom-test" step#1: boom');
    }
  });

  it('输入非法 → invalid_input（带 issues），步骤不执行', async () => {
    const ctx = await buildTestContext();
    let reached = false;
    const wf = defineWorkflow<{ seed: number }, unknown>({
      name: 'invalid-input-test',
      description: '入参校验',
      input: z.object({ seed: z.number() }),
      steps: [
        () => {
          reached = true;
          return null;
        },
      ],
    });

    const result = await wf.run({ seed: 'not-a-number' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_input');
      if (result.error.kind === 'invalid_input') {
        expect(result.error.issues.length).toBeGreaterThan(0);
        expect(result.error.message).toContain('invalid-input-test');
      }
    }
    expect(reached).toBe(false);
  });

  it('steps 为空 → 装配期直接抛错（不进 ToolResult 错误模型）', () => {
    expect(() =>
      defineWorkflow({
        name: 'empty-test',
        description: '空步骤',
        input: z.object({}),
        steps: [],
      }),
    ).toThrow('至少需要一个 step');
  });
});
