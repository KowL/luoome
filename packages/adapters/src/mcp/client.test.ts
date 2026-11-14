import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ReadOnlyMcpClient } from './client.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const bun = (process.env.PATH ?? '')
  .split(delimiter)
  .map((path) => join(path, 'bun'))
  .find(existsSync);
if (!bun) throw new Error('Bun required for real stdio MCP tests');
const server = fileURLToPath(new URL('../../../mcp/src/docs-server.ts', import.meta.url));
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-readonly-mcp-'));
  roots.push(root);
  const file = join(root, 'mcp-servers.json');
  const service = {
    enabled: true,
    command: bun,
    args: ['--no-env-file', server],
    tools: ['search_docs'],
    scenarios: ['research'],
  };
  const save = (change: object = {}) =>
    writeFileSync(
      file,
      JSON.stringify({ version: 1, services: { docs: { ...service, ...change } } }),
    );
  save();
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  return { file, save, client: new ReadOnlyMcpClient(file, logger) };
};

describe('controlled readonly MCP client (real stdio)', () => {
  it('discovers and calls the bundled readonly documentation service', async () => {
    const { client } = setup();
    const tools = await client.discover('research');
    expect(tools.map((tool) => tool.name)).toEqual(['mcp_docs__search_docs']);
    const tool = tools[0];
    if (!tool) throw new Error('Missing MCP tool');
    expect(tool.validate({ query: 'Watchlist' })).toBe(true);
    expect(tool.validate({ query: 123 })).toBe(false);
    const result = (await tool.call({ query: 'Watchlist' })) as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]?.text ?? '').matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'CONTEXT.md' })]),
    );
    expect(JSON.stringify(result)).not.toContain('luoome-readonly-mcp-');
  });

  it('requires explicit enablement, whitelist and scenario; disablement revokes old callables', async () => {
    const { client, save } = setup();
    expect(await client.discover('portfolio')).toEqual([]);
    const [tool] = await client.discover('research');
    if (!tool) throw new Error('Missing MCP tool');
    save({ enabled: false, command: '/disabled/do-not-start' });
    expect(await client.discover('research')).toEqual([]);
    expect(await tool.authorized()).toBe(false);
    await expect(tool.call({ query: 'Watchlist' })).rejects.toThrow(/revoked/);
    save({ tools: [] });
    expect(await client.discover('research')).toEqual([]);
    save({ tools: ['not_whitelisted'] });
    expect(await client.discover('research')).toEqual([]);
  });

  it('fails closed when config is absent, malformed or uses an implicit shell command', async () => {
    const { file, client, save } = setup();
    writeFileSync(file, '{');
    expect(await client.discover('research')).toEqual([]);
    save({ command: 'bun' });
    expect(await client.discover('research')).toEqual([]);
    rmSync(file);
    expect(await client.discover('research')).toEqual([]);
  });
});

describe('untrusted remote MCP declarations and results', () => {
  it('excludes writes/unmarked tools and rejects errors, large results, nontext content and declaration drift', async () => {
    const { file, save, client } = setup();
    const script = join(file, '..', 'fixture.ts');
    const source = `
import {Server} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
const server = new Server({name:'fixture',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,()=>({tools:['safe','unsafe','unmarked','failure','large','image'].map(name=>({name,description:'version-one',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false},...(name==='unmarked'?{}:{annotations:{readOnlyHint:name!=='unsafe',destructiveHint:name==='unsafe'}})}))}));
server.setRequestHandler(CallToolRequestSchema,({params})=>({isError:params.name==='failure',content:params.name==='image'?[{type:'image',data:'eA==',mimeType:'image/png'}]:[{type:'text',text:params.name==='large'?'x'.repeat(70000):'fixture-private-diagnostic'}]}));
await server.connect(new StdioServerTransport());
`;
    writeFileSync(script, source);
    save({
      args: ['--no-env-file', script],
      tools: ['safe', 'unsafe', 'unmarked', 'failure', 'large', 'image'],
    });
    const tools = await client.discover('research');
    expect(tools.map((tool) => tool.remoteName)).toEqual(['safe', 'failure', 'large', 'image']);
    for (const tool of tools.filter((tool) => tool.remoteName !== 'safe')) {
      await expect(tool.call({ query: 'example' })).rejects.toThrow('unsupported content');
    }
    const safe = tools[0];
    if (!safe) throw new Error('Missing safe tool');
    await expect(safe.call({ query: 3 })).rejects.toThrow('Invalid MCP input');
    writeFileSync(script, source.replace('version-one', 'version-two'));
    await expect(safe.call({ query: 'example' })).rejects.toThrow('declaration changed');
  });
});
