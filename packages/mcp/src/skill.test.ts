import { readFileSync } from 'node:fs';
import { toolRegistry } from '@luoome/tools';
import { describe, expect, it } from 'vitest';
import { resolveAllowedSideEffects, selectMcpTools } from './exposure.js';

const examples = readFileSync(
  new URL('../../../skills/luoome/references/examples.md', import.meta.url),
  'utf8',
);
const calls = [...examples.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(
  (match) => JSON.parse(match[1] ?? '') as { name: string; arguments: unknown },
);
const permitted = new Map(
  selectMcpTools(
    toolRegistry.all(),
    resolveAllowedSideEffects({
      LUOOME_EXPOSE_WRITE: 'true',
      LUOOME_EXPOSE_EXTERNAL: 'true',
    }),
  ).map((tool) => [tool.name, tool]),
);

describe('external Agent Skill examples', () => {
  it('all example calls are MCP-eligible and accepted by their current input schemas', () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const tool = permitted.get(call.name);
      expect(tool, call.name).toBeDefined();
      expect(tool?.inputSchema.safeParse(call.arguments).success, call.name).toBe(true);
    }
  });

  it('every inline tool reference is available through MCP', () => {
    for (const match of examples.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
      expect(permitted.has(match[1] ?? ''), match[1]).toBe(true);
    }
  });

  it('examples preserve the distinction between trial and persisted strategy runs', () => {
    const runs = calls.filter((call) => call.name === 'run_strategy');
    expect(runs.map((call) => call.arguments)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ persist: false, stockIds: expect.any(Array) }),
        expect.objectContaining({ persist: true }),
      ]),
    );
  });
});
