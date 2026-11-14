// Real stdio client checks with a temporary database and offline upstream fixtures.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
  for (let attempt = 0; attempt < 2; attempt++) {
    const client = await connect(home);
    try {
      const tools = await names(client);
      for (const name of ['list_watchlists', 'search_stocks', 'get_account_overview', 'get_advice'])
        assert.ok(tools.includes(name), name);
      for (const name of [
        'fetch_quote',
        'analyze_stock',
        'compute_indicators',
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

  const marketHome = join(root, 'market');
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
