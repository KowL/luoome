import { type AuditLogEvent, InvariantError, type ToolContext } from '@luoome/core';
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

  it('input issues 也会清理绝对路径和 URL', async () => {
    const tool = defineTool({
      name: 'test_sensitive_input',
      description: 't',
      sideEffect: 'read',
      input: z.object({
        value: z
          .string()
          .refine(
            () => false,
            'invalid value at /Users/lijun/.luoome/luoome.db https://api.example.test/error',
          ),
      }),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });
    const result = await tool.execute({ value: 'x' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'invalid_input') return;
    expect(result.error.message).not.toContain('/Users/lijun');
    expect(result.error.message).not.toContain('api.example.test');
    expect(result.error.issues[0]?.message).not.toContain('/Users/lijun');
    expect(result.error.issues[0]?.message).not.toContain('api.example.test');
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

  it('InvariantError 和 output schema 错误也会清理路径与 URL', async () => {
    const invariantTool = defineTool({
      name: 'test_sensitive_invariant',
      description: 't',
      sideEffect: 'read',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        throw new InvariantError('bad /Users/lijun/.luoome/luoome.db https://api.example.test/x');
      },
    });
    const invariantResult = await invariantTool.execute({}, ctx);
    expect(invariantResult.ok).toBe(false);
    if (!invariantResult.ok && invariantResult.error.kind === 'invariant_violation') {
      expect(invariantResult.error.message).not.toContain('/Users/lijun');
      expect(invariantResult.error.message).not.toContain('api.example.test');
    }

    const outputTool = defineTool({
      name: 'test_sensitive_output',
      description: 't',
      sideEffect: 'read',
      input: z.object({}),
      output: z.object({ required: z.string().url() }),
      handler: () => ({
        required: 'bad /Users/lijun/.luoome/luoome.db https://api.example.test/x',
      }),
    });
    const outputResult = await outputTool.execute({}, ctx);
    expect(outputResult.ok).toBe(false);
    if (!outputResult.ok && outputResult.error.kind === 'internal') {
      expect(outputResult.error.cause).not.toContain('/Users/lijun');
      expect(outputResult.error.cause).not.toContain('api.example.test');
    }
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

  it('错误响应清理绝对路径、URL 和密钥，不泄漏内部细节', async () => {
    const tool = defineTool({
      name: 'test_sensitive_error',
      description: 't',
      sideEffect: 'read',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        throw new Error(
          'failed at /Users/lijun/.luoome/luoome.db: https://api.example.test/x?token=secret Bearer secret-token sk-live-secret',
        );
      },
    });
    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
    if (result.error.kind !== 'internal') return;
    expect(result.error.cause).not.toContain('/Users/lijun');
    expect(result.error.cause).not.toContain('api.example.test');
    expect(result.error.cause).not.toContain('secret-token');
    expect(result.error.cause).not.toContain('sk-live-secret');
    expect(result.error.cause).toContain('[redacted]');
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

  it('非只读工具成功与失败都会写审计，读工具不写审计', async () => {
    const events: AuditLogEvent[] = [];
    ctx = {
      ...ctx,
      auditLog: { write: (event) => void events.push(event) },
      auditCaller: 'test',
    };
    const writeTool = defineTool({
      name: 'test_write',
      description: 't',
      sideEffect: 'write',
      input: z.object({ id: z.string() }),
      output: z.object({ saved: z.boolean() }),
      handler: () => ({ saved: true }),
    });
    const adviceTool = defineTool({
      name: 'test_advice',
      description: 't',
      sideEffect: 'advice',
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      handler: (input) => errNotFound('Advice', input.id),
    });

    await writeTool.execute({ id: 'a-1' }, ctx);
    await adviceTool.execute({ id: 'a-2' }, ctx);
    await doubleTool.execute({ n: 2 }, ctx);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      tool: 'test_write',
      sideEffect: 'write',
      result: 'ok',
      caller: 'test',
    });
    expect(events[0]).not.toHaveProperty('input');
    expect(events[0]).not.toHaveProperty('output');
    expect(events[1]).toMatchObject({
      tool: 'test_advice',
      sideEffect: 'advice',
      result: 'error',
      errorKind: 'not_found',
      caller: 'test',
    });
    expect(events[1]).not.toHaveProperty('input');
    expect(events[1]).not.toHaveProperty('error');
  });
});
