import { type AuditLogEvent, InvariantError } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolRegistry } from '../registry.js';
import { requestAuthChallengeTool } from './auth.js';
import { definePlatformTool } from './define-platform-tool.js';
import { createPlatformRegistry, platformToolRegistry } from './registry.js';
import { buildPlatformTestContext } from './testing-context.js';

describe('independent platform tool registry', () => {
  it('never appears in the business, MCP or model tool tables', () => {
    const platformNames = platformToolRegistry.all().map((tool) => tool.name);
    const businessNames = toolRegistry.all().map((tool) => tool.name);
    const mcpNames = toolRegistry.toMCP().map((tool) => tool.name);
    const modelNames = toolRegistry.toOpenAI().map((tool) => tool.function.name);
    for (const name of platformNames) {
      expect(businessNames).not.toContain(name);
      expect(mcpNames).not.toContain(name);
      expect(modelNames).not.toContain(name);
    }
    expect(() =>
      createPlatformRegistry([requestAuthChallengeTool, requestAuthChallengeTool]),
    ).toThrow('Duplicate');
  });

  it('reuses ToolResult validation, redaction and payload-free audit without an investment account', async () => {
    const fixture = buildPlatformTestContext();
    const events: AuditLogEvent[] = [];
    const ctx = {
      ...fixture.ctx,
      auditLog: { write: (event: AuditLogEvent) => void events.push(event) },
    };
    const tool = definePlatformTool({
      name: 'platform-test',
      description: 'fixture',
      actors: ['anonymous'],
      sideEffect: 'write',
      input: z.object({ n: z.number() }),
      output: z.object({ n: z.number() }),
      handler: () => {
        throw new InvariantError(
          'bad /Users/private/auth-secret https://private.test/error Bearer fixture-secret',
        );
      },
    });
    const invalid = await tool.execute({ n: 'wrong' }, ctx);
    expect(!invalid.ok && invalid.error.kind).toBe('invalid_input');
    const failed = await tool.execute({ n: 1 }, ctx);
    expect(!failed.ok && failed.error.kind).toBe('invariant_violation');
    expect(JSON.stringify(failed)).not.toContain('/Users/private');
    expect(JSON.stringify(failed)).not.toContain('private.test');
    expect(JSON.stringify(failed)).not.toContain('fixture-secret');
    expect(events).toHaveLength(2);
    expect(events[1]?.caller).toBe('anonymous');
    expect(events[1]).not.toHaveProperty('input');
    expect(events[1]).not.toHaveProperty('error');
  });
});
