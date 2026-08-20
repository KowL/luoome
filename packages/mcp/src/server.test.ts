import { toolRegistry } from '@luoome/tools';
import { describe, expect, it } from 'vitest';
import { resolveAllowedSideEffects, selectMcpTools } from './exposure.js';

describe('MCP sideEffect 暴露门控', () => {
  it('agent_run 默认不暴露，仅在 external 显式开启后可见', () => {
    const agentRun = toolRegistry.get('agent_run');
    expect(agentRun?.sideEffect).toBe('external');

    const defaults = resolveAllowedSideEffects({});
    expect(defaults.has('external')).toBe(false);
    expect(defaults.has(agentRun?.sideEffect ?? 'external')).toBe(false);

    const optedIn = resolveAllowedSideEffects({ LUOOME_EXPOSE_EXTERNAL: 'true' });
    expect(optedIn.has('external')).toBe(true);
    expect(optedIn.has(agentRun?.sideEffect ?? 'external')).toBe(true);
  });

  it('远程研究导入同时要求 write 与 external', () => {
    const externalOnly = selectMcpTools(
      toolRegistry.all(),
      resolveAllowedSideEffects({ LUOOME_EXPOSE_EXTERNAL: 'true' }),
    );
    expect(externalOnly.map((tool) => tool.name)).not.toContain('import_remote_research_document');

    const both = selectMcpTools(
      toolRegistry.all(),
      resolveAllowedSideEffects({
        LUOOME_EXPOSE_WRITE: 'true',
        LUOOME_EXPOSE_EXTERNAL: 'true',
      }),
    );
    expect(both.map((tool) => tool.name)).toContain('import_remote_research_document');
  });

  it('trade 硬卡不能由环境变量开启', () => {
    expect(() => resolveAllowedSideEffects({ LUOOME_EXPOSE_TRADE: 'true' })).toThrow(
      /trade tools are never exposed/,
    );
  });

  it('默认发现新 read，write/external 需 opt-in，内部 commit/sync/migration 永不暴露', () => {
    const defaults = selectMcpTools(toolRegistry.all(), resolveAllowedSideEffects({}));
    const defaultNames = defaults.map((tool) => tool.name);
    expect(defaultNames).toContain('list_strategies');
    expect(defaultNames).toContain('list_watchlists');
    expect(defaultNames).toContain('list_alert_plans');
    expect(defaultNames).toContain('list_strategy_watchlist_subscriptions');
    expect(defaultNames).not.toContain('create_strategy');
    expect(defaultNames).not.toContain('subscribe_strategy_to_watchlist');
    expect(defaultNames).not.toContain('run_strategy');

    const optedIn = selectMcpTools(
      toolRegistry.all(),
      resolveAllowedSideEffects({
        LUOOME_EXPOSE_WRITE: 'true',
        LUOOME_EXPOSE_EXTERNAL: 'true',
      }),
    );
    const optedInNames = optedIn.map((tool) => tool.name);
    expect(optedInNames).toContain('create_strategy');
    expect(optedInNames).toContain('run_strategy');
    for (const internalName of [
      'sync_watchlist_source',
      'sync_strategy_watchlist_subscriptions',
      'record_watch_run',
      'record_workflow_run',
      'save_report',
      'save_watch_trigger',
      'set_report_delivery_status',
    ]) {
      expect(optedInNames).not.toContain(internalName);
    }
    expect(optedInNames.some((name) => name.startsWith('migration_'))).toBe(false);
    expect(optedIn.some((tool) => tool.sideEffect === 'trade')).toBe(false);
  });
});
