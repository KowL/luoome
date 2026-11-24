import type { ListWatchlistsInput } from '@luoome/toolkit/tools/watchlist.js';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { catalogTools, toolCatalog } from './catalog.js';
import * as exports from './index.js';
import { applicationToolRegistry, toolRegistry } from './registry.js';

describe('typed tool catalog', () => {
  it('records P3 permissions, local computation dependencies and discovery baseline', () => {
    const baseline = {
      tools: toolRegistry.toMCP().sort((a, b) => a.name.localeCompare(b.name)),
      policy: Object.entries(toolCatalog)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => [
          name,
          entry.agent,
          entry.tool.sideEffect,
          entry.tool.requiredCapabilities,
          entry.agent ? entry.dependencies : [],
        ]),
    };
    expect(createHash('sha256').update(JSON.stringify(baseline)).digest('hex')).toBe(
      '31cb4884d6fe2624dc419b41d05e0459ad231c45f53bae2fd70e024e09b39c62',
    );
    const metadata = Object.entries(toolCatalog)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, { tool: _tool, ...entry }]) => [name, entry]);
    expect(createHash('sha256').update(JSON.stringify(metadata)).digest('hex')).toBe(
      'b814467a1eeeb8b2eed550ca982993eb138a55c225c92b289dfe92c6c814d8bd',
    );
    expect(toolCatalog.snapshot_account_performance.owner).toBe(
      'task.snapshot-account-performance',
    );
    expect(toolCatalog.snapshot_account_performance.tool.requiredCapabilities).toEqual([
      'write',
      'external',
    ]);
    expect(toolRegistry.get('snapshot_account_performance')).toBeUndefined();
    expect(toolCatalog.run_strategy.owner).toBe('business.strategy-execution');
    expect(toolCatalog.run_strategy.execution).toBe('p3');
    for (const name of [
      'begin_watch_delivery',
      'commit_watch_evaluation',
      'save_watch_rule_states',
      'save_watch_trigger',
      'set_watch_trigger_delivery_status',
    ] as const) {
      expect(toolCatalog[name].owner).toBe('business.watch-monitoring');
      expect(toolCatalog[name].execution).toBe('p3');
    }
    expect(toolCatalog.set_watch_trigger_feedback.owner).toBe('business.watch');
    for (const name of [
      'analyze_stock',
      'analyze_position',
      'market_outlook',
      'analyze_strategy_candidate',
    ] as const) {
      expect(toolCatalog[name].owner).toBe('business.analysis');
      expect(toolCatalog[name].execution).toBe('p3');
    }
    expect(toolCatalog.run_strategy.dependencies).toEqual([]);
    expect(toolCatalog.compute_indicators.dependencies).toEqual([]);
    expect(toolCatalog.sync_daily_bars.execution).toBe('p2');
    expect(toolCatalog.sync_daily_bars.tool.requiredCapabilities).toEqual(['external', 'write']);
    for (const entry of Object.values(toolCatalog)) expect(entry.owner).toBeTruthy();
    expect(toolCatalog.get_strategy_insight_facts.owner).toBe('shared-query');
    expect(toolCatalog.generate_strategy_insight.owner).toBe('business.strategy-insight');
    expect(toolCatalog.generate_strategy_insight.optionalPlugins).toEqual(['strategy.ai-insight']);
    expect(toolCatalog.sync_daily_bars.owner).toBe('task.daily-bars-sync');
    expect(toolCatalog.compute_indicators.owner).not.toBe('shared-query');
    expect(toolCatalog.run_strategy.modes.scheduled.conditional).toContain('live:limit-up-ladder');
    expect(toolCatalog.run_strategy.modes.replay.conditional).toContain('archive:limit-up-ladder');
    // P1-5 / P1-6：批量生成不属 Agent/MCP 只读面，两个 brief 查询工具进共享只读基线。
    expect(toolCatalog.generate_stock_briefs.owner).toBe('business.analysis');
    expect(toolCatalog.generate_stock_briefs.execution).toBe('p3');
    expect(toolCatalog.generate_stock_briefs.agent).toBe(false);
    expect(toolCatalog.generate_stock_briefs.tool.sideEffect).toBe('advice');
    expect(toolRegistry.get('generate_stock_briefs')).toBeUndefined();
    expect(applicationToolRegistry.get('generate_stock_briefs')).toBe(
      toolCatalog.generate_stock_briefs.tool,
    );
    for (const name of ['get_stock_brief', 'list_stock_briefs'] as const) {
      expect(toolCatalog[name].owner).toBe('shared-query');
      expect(toolCatalog[name].agent).toBe(true);
      expect(toolCatalog[name].tool.sideEffect).toBe('read');
      expect(toolRegistry.get(name)).toBe(toolCatalog[name].tool);
    }
  });
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

import { createHash } from 'node:crypto';
