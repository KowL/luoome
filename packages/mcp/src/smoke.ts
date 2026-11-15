// Real stdio client checks with a temporary database and offline upstream fixtures.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginConfigStore } from '@luoome/adapters';
import { money, stockCode, strategyDefinitionHash } from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const root = mkdtempSync(join(tmpdir(), 'luoome-mcp-smoke-'));
const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
const fixture = join(root, 'network-fixture.ts');
writeFileSync(
  fixture,
  `
globalThis.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?')) {
    throw new Error('Smoke test forbids unexpected network access');
  }
  return Response.json({code: '1', data: {list: [{
    code: 'mcp-fixture-news', title: 'MCP fixture news',
    showTime: '2026-11-13 10:00:00', mediaName: 'fixture',
    uniqueUrl: 'https://example.com/mcp-fixture'
  }]}});
};
`,
);

const connect = async (home: string, extraEnv: Record<string, string> = {}) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--no-env-file', '--preload', fixture, entry],
    cwd: root,
    env: { PATH: process.env.PATH ?? '', LUOOME_HOME: home, ...extraEnv },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'luoome-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await transport.close();
    throw error;
  }
};

const names = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name);
const data = (result: Awaited<ReturnType<Client['callTool']>>) => {
  assert.ok(Array.isArray(result.content));
  const text = result.content[0];
  assert.equal(text?.type, 'text');
  return JSON.parse(text.text as string);
};

try {
  const home = join(root, 'local');
  new PluginConfigStore(join(home, 'plugins.json')).initialize();
  const seed = createDrizzleRepos(join(home, 'luoome.db'));
  await seed.repos.stock.save({
    id: '000001.SZ',
    code: stockCode('000001'),
    exchange: 'SZ',
    name: 'fixture local',
  });
  await seed.repos.dailyBar.saveMany([
    {
      stockId: '000001.SZ',
      date: new Date(Date.now() - 86400000),
      open: money(10),
      high: money(10),
      low: money(10),
      close: money(10),
      volume: 100,
      adjustment: 'qfq',
      source: 'offline-fixture',
    },
  ]);
  seed.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const client = await connect(home);
    try {
      const tools = await names(client);
      for (const name of [
        'list_watchlists',
        'search_stocks',
        'get_account_overview',
        'get_advice',
        'compute_indicators',
      ])
        assert.ok(tools.includes(name), name);
      for (const name of [
        'fetch_quote',
        'analyze_stock',
        'limit_up_ladder',
        'fetch_news',
        'search_research_documents',
        'create_watchlist',
        'add_trade',
      ])
        assert.ok(!tools.includes(name), name);
      const watches = await client.callTool({ name: 'list_watchlists', arguments: {} });
      assert.notEqual(watches.isError, true);
      assert.deepEqual(data(watches), { items: [], total: 0 });
      const search = await client.callTool({
        name: 'search_stocks',
        arguments: { query: 'fixture' },
      });
      assert.notEqual(search.isError, true);
      assert.equal(data(search).source, 'local-history');
      assert.equal(data(search).stocks[0].id, '000001.SZ');
      const indicators = await client.callTool({
        name: 'compute_indicators',
        arguments: { stockId: '000001.SZ' },
      });
      assert.notEqual(indicators.isError, true);
      assert.equal(data(indicators).barsCount, 1);
      assert.equal(data(indicators).indicators.close, 10);
      const account = await client.callTool({ name: 'get_account_overview', arguments: {} });
      assert.equal(account.isError, true);
      assert.equal(data(account).kind, 'not_found');
      await assert.rejects(
        client.callTool({ name: 'fetch_quote', arguments: {} }),
        /not found or not exposed/,
      );
    } finally {
      await client.close();
    }
  }
  console.log('ok: no providers or credentials; local discovery/calls and restart');
  const strategySeed = createDrizzleRepos(join(home, 'luoome.db'));
  const now = new Date();
  const definition = {
    schemaVersion: 1 as const,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ' as const, excludeStockIds: [] },
    selection: {
      logic: 'all' as const,
      rules: [
        {
          id: 'positive',
          name: 'fixture price',
          when: 'quote.close > 0',
          evidence: ['fixture only'],
        },
      ],
    },
    signals: { entry: [], exit: [], risk: [] },
  };
  await strategySeed.repos.strategy.create({
    id: 'mcp-strategy',
    name: 'MCP fixture strategy',
    description: 'offline fixture',
    owner: 'user',
    status: 'active',
    currentVersionId: 'mcp-strategy-v1',
    createdAt: now,
    updatedAt: now,
  });
  await strategySeed.repos.strategy.createVersion({
    id: 'mcp-strategy-v1',
    strategyId: 'mcp-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  });
  await strategySeed.repos.stockUniverse.applySnapshot({
    syncId: 'mcp-universe',
    appliedAt: now,
    snapshot: {
      source: 'fixture',
      coverage: 'CN_A_SHARES_SH_SZ',
      observedAt: now,
      complete: true,
      reportedTotal: 1,
      entries: [
        {
          stockId: '000001.SZ',
          code: stockCode('000001'),
          exchange: 'SZ',
          name: 'fixture local',
          listingStatus: 'listed',
        },
      ],
    },
  });
  strategySeed.close();
  const strategyStore = new PluginConfigStore(join(home, 'plugins.json'));
  const setExecution = (enabled: boolean) => {
    const read = strategyStore.read();
    assert.ok(read.ok);
    strategyStore.set('business.strategy-execution', enabled, read.config);
  };
  setExecution(true);
  const strategyClient = await connect(home, {
    LUOOME_EXPOSE_EXTERNAL: 'true',
    LUOOME_EXPOSE_WRITE: 'true',
  });
  let changes = 0;
  strategyClient.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changes++;
  });
  const waitChange = async (previous: number) => {
    const deadline = Date.now() + 5000;
    while (changes <= previous && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(changes > previous, 'same connection receives tools/list_changed');
  };
  try {
    assert.equal(strategyClient.getServerCapabilities()?.tools?.listChanged, true);
    assert.ok((await names(strategyClient)).includes('run_strategy'));
    const run = await strategyClient.callTool({
      name: 'run_strategy',
      arguments: { strategyId: 'mcp-strategy', mode: 'scheduled' },
    });
    assert.notEqual(run.isError, true);
    assert.equal(data(run).run.status, 'complete');
    assert.equal(data(run).results.length, 1);
    const beforeDisable = changes;
    setExecution(false);
    await waitChange(beforeDisable);
    assert.ok(!(await names(strategyClient)).includes('run_strategy'));
    await assert.rejects(
      strategyClient.callTool({
        name: 'run_strategy',
        arguments: { strategyId: 'mcp-strategy', mode: 'scheduled' },
      }),
      /not found or not exposed/,
    );
    const history = await strategyClient.callTool({
      name: 'get_strategy',
      arguments: { strategyId: 'mcp-strategy' },
    });
    assert.notEqual(history.isError, true);
    assert.equal(data(history).strategy.id, 'mcp-strategy');
    const beforeEnable = changes;
    setExecution(true);
    await waitChange(beforeEnable);
    assert.ok((await names(strategyClient)).includes('run_strategy'));
    setExecution(false);
  } finally {
    await strategyClient.close();
  }
  console.log(
    'ok: controlled strategy execution uses local data; same-connection disable revokes discovery/calls and retains history',
  );

  const enableSource = (home: string) => {
    const store = new PluginConfigStore(join(home, 'plugins.json'));
    const config = store.initialize();
    return store.set('source.eastmoney', true, store.set('source.sina', true, config));
  };
  const marketHome = join(root, 'market');
  enableSource(marketHome);
  const config = {
    LUOOME_MARKET_PROVIDER: 'real',
    LUOOME_MARKET_SOURCES: 'sina',
    LUOOME_NEWS_SOURCES: 'eastmoney',
  };
  const unauthorized = await connect(marketHome, config);
  try {
    assert.ok(!(await names(unauthorized)).includes('fetch_news'));
  } finally {
    await unauthorized.close();
  }
  const authorized = await connect(marketHome, {
    ...config,
    LUOOME_EXPOSE_EXTERNAL: 'true',
    LUOOME_EXPOSE_WRITE: 'true',
  });
  try {
    const tools = await names(authorized);
    assert.ok(tools.includes('fetch_news'));
    assert.ok(tools.includes('fetch_quote'));
    assert.ok(!tools.includes('fetch_index_quotes'), 'Sina has no realtime index capability');
    assert.ok(!tools.includes('analyze_stock'), 'no model credentials');
    assert.ok(!tools.includes('limit_up_market'), 'no fuyao credentials');
    assert.ok(!tools.includes('add_trade'));
    const news = await authorized.callTool({ name: 'fetch_news', arguments: {} });
    assert.notEqual(news.isError, true);
    assert.equal(data(news).items[0].id, 'mcp-fixture-news');
    const store = new PluginConfigStore(join(marketHome, 'plugins.json'));
    const current = store.read();
    assert.ok(current.ok);
    const off = store.set('source.eastmoney', false, current.config);
    assert.ok(!(await names(authorized)).includes('fetch_news'));
    await assert.rejects(
      authorized.callTool({ name: 'fetch_news', arguments: {} }),
      /not found or not exposed/,
    );
    store.set('source.eastmoney', true, off);
    assert.ok((await names(authorized)).includes('fetch_news'));
    const created = await authorized.callTool({
      name: 'create_watchlist',
      arguments: { name: 'smoke watchlist', kind: 'personal', membershipPolicy: 'manual' },
    });
    assert.notEqual(created.isError, true);
    assert.equal(
      data(await authorized.callTool({ name: 'list_watchlists', arguments: {} })).total,
      1,
    );
  } finally {
    await authorized.close();
  }
  console.log(
    'ok: configured dependencies AND authorization; real news adapter with offline HTTP fixture',
  );

  enableSource(join(root, 'model'));
  const model = await connect(join(root, 'model'), {
    ...config,
    MINIMAX_API_KEY: 'offline-fixture-only',
  });
  try {
    assert.ok((await names(model)).includes('analyze_stock'));
    const result = await model.callTool({
      name: 'analyze_stock',
      arguments: { stockId: 'missing' },
    });
    assert.equal(result.isError, true);
    assert.equal(data(result).kind, 'not_found');
  } finally {
    await model.close();
  }
  const localWriteHome = join(root, 'local-write');
  const localWriter = await connect(localWriteHome, { LUOOME_EXPOSE_WRITE: 'true' });
  try {
    const result = await localWriter.callTool({
      name: 'create_watchlist',
      arguments: { name: 'local persisted', kind: 'personal', membershipPolicy: 'manual' },
    });
    assert.notEqual(result.isError, true);
  } finally {
    await localWriter.close();
  }
  const localReader = await connect(localWriteHome);
  try {
    const result = await localReader.callTool({ name: 'list_watchlists', arguments: {} });
    assert.equal(data(result).items[0].watchlist.name, 'local persisted');
    await assert.rejects(
      localReader.callTool({
        name: 'create_watchlist',
        arguments: { name: 'denied', kind: 'personal', membershipPolicy: 'manual' },
      }),
      /not found or not exposed/,
    );
  } finally {
    await localReader.close();
  }
  console.log('ok: model readiness and persisted local data without providers');

  const denied = await connect(join(root, 'denied'), {
    LUOOME_EXPOSE_READ: 'false',
    LUOOME_EXPOSE_ADVICE: 'false',
  });
  try {
    assert.deepEqual(await names(denied), []);
  } finally {
    await denied.close();
  }
  await assert.rejects(connect(join(root, 'trade'), { LUOOME_EXPOSE_TRADE: 'true' }));
  console.log('ok: read/advice opt-out and trade startup hard gate');
} finally {
  rmSync(root, { recursive: true, force: true });
}
