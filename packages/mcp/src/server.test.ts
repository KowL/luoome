import { toolRegistry } from '@luoome/tools';
import { describe, expect, it } from 'vitest';
import { resolveAllowedSideEffects, selectMcpTools } from './exposure.js';

const namesOf = (tools: readonly { readonly name: string }[]): string[] =>
  tools.map((tool) => tool.name);

describe('MCP sideEffect 暴露门控（34 核心 Agent Tool）', () => {
  it('external 类 tool 仅在 LUOOME_EXPOSE_EXTERNAL 显式开启后暴露', () => {
    expect(toolRegistry.get('agent_run')).toBeUndefined();
    const quote = toolRegistry.get('fetch_quote');
    expect(quote?.sideEffect).toBe('external');

    const defaults = resolveAllowedSideEffects({});
    expect(defaults.has('external')).toBe(false);
    expect(namesOf(selectMcpTools(toolRegistry.all(), defaults))).not.toContain('fetch_quote');
    expect(namesOf(selectMcpTools(toolRegistry.all(), defaults))).toContain('search_stocks');

    const optedIn = resolveAllowedSideEffects({ LUOOME_EXPOSE_EXTERNAL: 'true' });
    expect(optedIn.has('external')).toBe(true);
    expect(namesOf(selectMcpTools(toolRegistry.all(), optedIn))).toContain('fetch_quote');
  });

  it('写/外部组合能力需同时 opt-in；write-only 工具在 write 开启后暴露', () => {
    const externalOnly = namesOf(
      selectMcpTools(
        toolRegistry.all(),
        resolveAllowedSideEffects({ LUOOME_EXPOSE_EXTERNAL: 'true' }),
      ),
    );
    expect(externalOnly).not.toContain('run_strategy');
    expect(externalOnly).not.toContain('save_strategy_version');
    expect(externalOnly).not.toContain('run_strategy_backtest');
    expect(externalOnly).toContain('fetch_quote');

    const writeOnly = namesOf(
      selectMcpTools(
        toolRegistry.all(),
        resolveAllowedSideEffects({ LUOOME_EXPOSE_WRITE: 'true' }),
      ),
    );
    expect(writeOnly).toContain('save_strategy_version');
    expect(writeOnly).toContain('run_strategy_backtest');
    expect(writeOnly).toContain('update_watchlist_members');
    expect(writeOnly).not.toContain('run_strategy');

    const both = namesOf(
      selectMcpTools(
        toolRegistry.all(),
        resolveAllowedSideEffects({
          LUOOME_EXPOSE_WRITE: 'true',
          LUOOME_EXPOSE_EXTERNAL: 'true',
        }),
      ),
    );
    expect(both).toContain('run_strategy');
    expect(both).toContain('save_research_document');
  });

  it('add_trade 即使开启 write/external 也不通过 MCP 暴露', () => {
    const names = namesOf(
      selectMcpTools(
        toolRegistry.all(),
        resolveAllowedSideEffects({
          LUOOME_EXPOSE_WRITE: 'true',
          LUOOME_EXPOSE_EXTERNAL: 'true',
        }),
      ),
    );
    expect(names).not.toContain('add_trade');
    expect(names).toContain('list_trades');
  });

  it('trade 硬卡不能由环境变量开启', () => {
    expect(() => resolveAllowedSideEffects({ LUOOME_EXPOSE_TRADE: 'true' })).toThrow(
      /trade tools are never exposed/,
    );
  });

  it('默认发现 34 中的 read/advice，write/external 需 opt-in，旧 App Service 名永不暴露', () => {
    const defaults = selectMcpTools(toolRegistry.all(), resolveAllowedSideEffects({}));
    const defaultNames = namesOf(defaults);
    expect(defaultNames).toContain('list_strategies');
    expect(defaultNames).toContain('list_watchlists');
    expect(defaultNames).toContain('get_account_overview');
    expect(defaultNames).toContain('list_watch_plans');
    expect(defaultNames).toContain('search_research_documents');
    expect(defaultNames).not.toContain('save_strategy_version');
    expect(defaultNames).not.toContain('run_strategy');
    expect(defaultNames).not.toContain('fetch_news');

    const optedIn = selectMcpTools(
      toolRegistry.all(),
      resolveAllowedSideEffects({
        LUOOME_EXPOSE_WRITE: 'true',
        LUOOME_EXPOSE_EXTERNAL: 'true',
      }),
    );
    const optedInNames = namesOf(optedIn);
    expect(optedInNames).toContain('save_strategy_version');
    expect(optedInNames).toContain('run_strategy');
    for (const retired of [
      'list_holdings',
      'create_account',
      'create_strategy',
      'trial_strategy',
      'propose_strategy_version_draft',
      'list_alert_plans',
      'list_trading_plans',
      'sync_watchlist_source',
      'save_report',
      'record_workflow_run',
    ]) {
      expect(optedInNames, retired).not.toContain(retired);
    }
    expect(optedInNames.some((name) => name.startsWith('migration_'))).toBe(false);
    expect(optedIn.some((tool) => tool.sideEffect === 'trade')).toBe(false);
    expect(optedIn.length).toBeLessThanOrEqual(toolRegistry.all().length);
  });
});
