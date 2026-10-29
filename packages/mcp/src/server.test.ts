import { toolRegistry } from '@luoome/tools';
import { describe, expect, it } from 'vitest';
import { resolveAllowedSideEffects, resolveMcpToolNames, selectMcpTools } from './exposure.js';

describe('MCP sideEffect 暴露门控', () => {
  it('external 工具默认不暴露，仅在 external 显式开启后可见', () => {
    const fetchQuote = toolRegistry.get('fetch_quote');
    expect(fetchQuote?.sideEffect).toBe('external');

    const defaults = resolveAllowedSideEffects({});
    expect(defaults.has('external')).toBe(false);
    expect(defaults.has(fetchQuote?.sideEffect ?? 'external')).toBe(false);

    const optedIn = resolveAllowedSideEffects({ LUOOME_EXPOSE_EXTERNAL: 'true' });
    expect(optedIn.has('external')).toBe(true);
    expect(optedIn.has(fetchQuote?.sideEffect ?? 'external')).toBe(true);
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

  it('Strategy 持久化外部 tools 必须同时开启 write 与 external，草案/trial 仅需 external', () => {
    const externalOnly = selectMcpTools(
      toolRegistry.all(),
      resolveAllowedSideEffects({ LUOOME_EXPOSE_EXTERNAL: 'true' }),
    );
    const externalOnlyNames = externalOnly.map((tool) => tool.name);
    expect(externalOnlyNames).not.toContain('run_strategy');
    expect(externalOnlyNames).not.toContain('prepare_strategy_data');
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
    expect(bothNames).toContain('prepare_strategy_data');
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
    // fetch_news 访问第三方新闻源，归为 external：默认 read 面不含，opt-in 后可见。
    expect(defaultNames).not.toContain('fetch_news');
    expect(defaultNames).not.toContain('fetch_sector_quotes');

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
    expect(optedInNames).toContain('fetch_news');
    expect(optedInNames).toContain('fetch_sector_quotes');
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

describe('MCP name exposure policy', () => {
  const select = (env: NodeJS.ProcessEnv) =>
    selectMcpTools(
      toolRegistry.all(),
      resolveAllowedSideEffects(env),
      resolveMcpToolNames(env),
    ).map((tool) => tool.name);

  it('trims exact allowlist names and gives deny precedence', () => {
    expect(
      select({
        LUOOME_EXPOSE_TOOLS: ' list_holdings, get_advice, list_holdings ',
        LUOOME_EXPOSE_DENY: ' get_advice ',
      }),
    ).toEqual(['list_holdings']);
  });

  it.each(['', ' , ', 'list_holding', '*'])('fails closed for %j', (names) => {
    expect(select({ LUOOME_EXPOSE_TOOLS: names })).toEqual([]);
  });

  it('allowlist never grants missing capabilities', () => {
    expect(
      select({ LUOOME_EXPOSE_TOOLS: 'create_strategy,fetch_quote,record_decision_trade' }),
    ).toEqual([]);
  });

  it('preserves research opt-in and allows explicit deny after opt-in', () => {
    expect(select({})).not.toContain('get_research_document');
    expect(select({ LUOOME_EXPOSE_RESEARCH: 'true' })).toContain('get_research_document');
    expect(
      select({ LUOOME_EXPOSE_RESEARCH: 'true', LUOOME_EXPOSE_DENY: 'get_research_document' }),
    ).not.toContain('get_research_document');
  });

  it('does not classify new tools by substring', () => {
    expect(
      selectMcpTools(
        [{ name: 'research_health_check', sideEffect: 'read' }],
        resolveAllowedSideEffects({}),
        resolveMcpToolNames({}),
      ),
    ).toHaveLength(1);
  });

  it('never exposes trade even with a caller-supplied capability set', () => {
    expect(selectMcpTools([{ name: 'trade', sideEffect: 'trade' }], new Set(['trade']))).toEqual(
      [],
    );
  });
});

describe('queue capability', () => {
  it('requires explicit queue opt-in independently of name lists and write permission', () => {
    const names = { LUOOME_EXPOSE_TOOLS: 'claim_analysis_jobs,record_advice' };
    const select = (env: NodeJS.ProcessEnv) =>
      selectMcpTools(toolRegistry.all(), resolveAllowedSideEffects(env), resolveMcpToolNames(env));
    expect(select(names)).toEqual([]);
    expect(select({ ...names, LUOOME_EXPOSE_WRITE: 'true' })).toEqual([]);
    expect(
      select({ ...names, LUOOME_EXPOSE_QUEUE: 'true' })
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['claim_analysis_jobs', 'record_advice']);
    expect(
      select({ LUOOME_EXPOSE_QUEUE: 'true' }).some((tool) => tool.sideEffect === 'write'),
    ).toBe(false);
  });
});
