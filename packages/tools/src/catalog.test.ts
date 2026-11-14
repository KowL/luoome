import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { catalogTools, toolCatalog } from './catalog.js';
import * as exports from './index.js';
import { applicationToolRegistry, toolRegistry } from './registry.js';
import type { ListWatchlistsInput } from './tools/watchlist.js';

describe('typed tool catalog', () => {
  it('explicit inventory covers every exported tool exactly once with its actual name', () => {
    const exportedTools = Object.values(exports).filter(
      (value) =>
        typeof value === 'object' && value !== null && 'execute' in value && 'name' in value,
    );
    expect(new Set(Object.values(catalogTools))).toEqual(new Set(exportedTools));
    expect(Object.keys(catalogTools)).toHaveLength(new Set(Object.values(catalogTools)).size);
    for (const [name, entry] of Object.entries(toolCatalog)) {
      expect(entry.tool.name, name).toBe(name);
      expect(applicationToolRegistry.get(name), name).toBe(entry.tool);
      expect(toolRegistry.get(name), name).toBe(entry.agent ? entry.tool : undefined);
    }
  });

  it('retains raw schema input including defaults for typed callers', () => {
    expectTypeOf<z.input<typeof catalogTools.list_watchlists.inputSchema>>().toEqualTypeOf<
      z.input<typeof ListWatchlistsInput>
    >();
    expect(catalogTools.list_watchlists.inputSchema.safeParse({}).success).toBe(true);
  });
});
