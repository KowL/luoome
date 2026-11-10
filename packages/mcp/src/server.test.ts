import { toolRegistry } from '@luoome/tools';
import { describe, expect, it } from 'vitest';
import { resolveAllowedSideEffects, selectMcpTools } from './exposure.js';

describe('MCP sideEffect 暴露门控', () => {
  it('external 类 tool 仅在 LUOOME_EXPOSE_EXTERNAL 显式开启后暴露', () => {
    expect(toolRegistry.get('agent_run')).toBeUndefined();
    const quote = toolRegistry.get('fetch_quote');
    expect(quote?.sideEffect).toBe('external');

    const defaults = resolveAllowedSideEffects({});
    expect(defaults.has('external')).toBe(false);
    expect(selectMcpTools(toolRegistry.all(), defaults).map((tool) => tool.name)).not.toContain(
      'fetch_quote',
    );

    const optedIn = resolveAllowedSideEffects({ LUOOME_EXPOSE_EXTERNAL: 'true' });
    expect(optedIn.has('external')).toBe(true);
    expect(selectMcpTools(toolRegistry.all(), optedIn).map((tool) => tool.name)).toContain(
      'fetch_quote',
    );
  });

  it('Strategy 持久化外部 tools 必须同时开启 write 与 external，草案/trial 仅需 external', () => {
    const externalOnly = selectMcpTools(
      toolRegistry.all(),
      resolveAllowedSideEffects({ LUOOME_EXPOSE_EXTERNAL: 'true' }),
    );
    const externalOnlyNames = externalOnly.map((tool) => tool.name);
    expect(externalOnlyNames).not.toContain('run_strategy');
    expect(externalOnlyNames).toContain('trial_strategy');
    expect(externalOnlyNames).toContain('propose_strategy_version_draft');
    expect(externalOnlyNames).toContain('trial_strategy_version');

    const both = selectMcpTools(
      toolRegistry.all(),
      resolveAllowedSideEffects({
        LUOOME_EXPOSE_WRITE: 'true',
        LUOOME_EXPOSE_EXTERNAL: 'true',
      }),
    );
    const bothNames = both.map((tool) => tool.name);
    expect(bothNames).toContain('run_strategy');
    expect(bothNames).toContain('trial_strategy');
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
