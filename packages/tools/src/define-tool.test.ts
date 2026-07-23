import { InvariantError, type ToolContext } from '@luoome/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, errNotFound } from './define-tool.js';
import { buildTestContext } from './testing/context.js';

const doubleTool = defineTool({
  name: 'test_double',
  description: '测试用：入参翻倍',
  sideEffect: 'read',
  input: z.object({ n: z.number() }),
  output: z.object({ doubled: z.number() }),
  handler: (input) => ({ doubled: input.n * 2 }),
});

describe('defineTool execute 错误模型', () => {
  let ctx: ToolContext;

  beforeEach(async () => {
    ctx = await buildTestContext();
  });

  it('正常路径：input parse → handler → output parse → Ok(data)', async () => {
    const result = await doubleTool.execute({ n: 21 }, ctx);
    expect(result).toEqual({ ok: true, data: { doubled: 42 } });
  });

  it('input parse 失败 → invalid_input（带 issues），execute 不抛异常', async () => {
    const result = await doubleTool.execute({ n: 'not-a-number' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    if (result.error.kind !== 'invalid_input') return;
    expect(result.error.issues.length).toBeGreaterThan(0);
    expect(result.error.message).toContain('test_double');
  });

  it('非对象输入同样 → invalid_input', async () => {
    const result = await doubleTool.execute(null, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('handler 返回 errNotFound → 原样透传 not_found', async () => {
    const tool = defineTool({
      name: 'test_not_found',
      description: 't',
      sideEffect: 'read',
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      handler: (input) => errNotFound('Thing', input.id),
    });
    const result = await tool.execute({ id: 'x-1' }, ctx);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Thing', id: 'x-1' },
    });
  });

  it('handler 抛 InvariantError → invariant_violation', async () => {
    const tool = defineTool({
      name: 'test_invariant',
      description: 't',
      sideEffect: 'read',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        throw new InvariantError('quantity < 0');
      },
    });
    const result = await tool.execute({}, ctx);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'invariant_violation', message: 'quantity < 0' },
    });
  });

  it('handler 抛其他异常 → internal（含 cause）', async () => {
    const tool = defineTool({
      name: 'test_boom',
      description: 't',
      sideEffect: 'read',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        throw new Error('db is on fire');
      },
    });
    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
    if (result.error.kind !== 'internal') return;
    expect(result.error.cause).toContain('db is on fire');
  });

  it('handler 产出不符合 output schema → internal', async () => {
    const tool = defineTool({
      name: 'test_bad_output',
      description: 't',
      sideEffect: 'read',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: 'yes' }) as unknown as { ok: boolean },
    });
    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('internal');
  });

  it('成功路径会执行 output transform（ branded Money 往返）', async () => {
    const tool = defineTool({
      name: 'test_round',
      description: 't',
      sideEffect: 'read',
      input: z.object({}),
      output: z.object({ v: z.number().transform((n) => Math.round(n)) }),
      handler: () => ({ v: 1.6 }),
    });
    const result = await tool.execute({}, ctx);
    expect(result).toEqual({ ok: true, data: { v: 2 } });
  });
});
