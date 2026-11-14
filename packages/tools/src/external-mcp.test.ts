import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { discoverExternalMcpTools } from './external-mcp.js';
import { buildTestContext } from './testing/context.js';

describe('external MCP ToolResult and audit boundary', () => {
  it('validates remote inputs, records only safe audit metadata, and rejects stale callables after disablement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-external-tool-'));
    const config = join(root, 'mcp-servers.json');
    const command = (process.env.PATH ?? '')
      .split(delimiter)
      .map((path) => join(path, 'bun'))
      .find(existsSync);
    if (!command) throw new Error('Bun required');
    const service = {
      enabled: true,
      command,
      args: [
        '--no-env-file',
        fileURLToPath(new URL('../../mcp/src/docs-server.ts', import.meta.url)),
      ],
      tools: ['search_docs'],
      scenarios: ['research'],
    };
    const save = (enabled: boolean) =>
      writeFileSync(
        config,
        JSON.stringify({ version: 1, services: { docs: { ...service, enabled } } }),
      );
    const audit = vi.fn();
    const context = { ...(await buildTestContext()), auditLog: { write: audit } };
    try {
      save(true);
      const [external] = await discoverExternalMcpTools(config, context, 'research');
      if (!external) throw new Error('Missing external tool');
      expect(await external.callable.execute({ query: 12 })).toMatchObject({
        ok: false,
        output: { error: { kind: 'invalid_input' } },
      });
      expect(await external.callable.execute({ query: 'Watchlist' })).toMatchObject({
        ok: true,
        output: { service: 'docs', tool: 'search_docs' },
      });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'mcp_docs__search_docs',
          sideEffect: 'external',
          result: 'ok',
        }),
      );
      expect(JSON.stringify(audit.mock.calls)).not.toContain('Watchlist');
      save(false);
      expect(await discoverExternalMcpTools(config, context, 'research')).toEqual([]);
      expect(await external.callable.execute({ query: 'Watchlist' })).toMatchObject({
        ok: false,
        output: { error: { kind: 'permission_denied' } },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
