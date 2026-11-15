import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createDshIntegrationFixture } from './integration-fixture.js';

const parse = (body: string) =>
  body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);

describe('readonly external MCP through the real Web and DSH chain', () => {
  it('exposes only the enabled whitelisted tool, returns its result to Agent, and removes it after disablement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-mcp-chat-'));
    const config = join(root, 'mcp-servers.json');
    const service = {
      enabled: true,
      command: process.execPath,
      args: [
        '--no-env-file',
        fileURLToPath(new URL('../../../../packages/mcp/src/docs-server.ts', import.meta.url)),
      ],
      tools: ['search_docs'],
      scenarios: ['research'],
    };
    const save = (enabled: boolean) =>
      writeFileSync(
        config,
        JSON.stringify({ version: 1, services: { docs: { ...service, enabled } } }),
      );
    save(true);
    const fixture = await createDshIntegrationFixture({ externalMcpConfig: config });
    try {
      const manage = async (
        enabled: boolean,
        tools = ['search_docs'],
        scenarios = ['research'],
      ) => {
        const view = z
          .object({ data: z.object({ revision: z.string() }) })
          .parse(await (await fixture.request('/api/settings/mcp')).json());
        const result = z.object({ ok: z.boolean() }).parse(
          await (
            await fixture.request('/api/settings/mcp/docs', {
              method: 'POST',
              body: JSON.stringify({ enabled, tools, scenarios, revision: view.data.revision }),
            })
          ).json(),
        );
        expect(result.ok).toBe(true);
      };
      const preview = async () =>
        z
          .object({
            data: z.object({ tools: z.array(z.object({ name: z.string(), service: z.string() })) }),
          })
          .parse(
            await (
              await fixture.request('/api/settings/mcp/preview', {
                method: 'POST',
                body: JSON.stringify({ scenario: 'research' }),
              })
            ).json(),
          ).data.tools;
      await manage(true, []);
      expect(await preview()).toEqual([]);
      await manage(true, ['search_docs'], ['review']);
      expect(await preview()).toEqual([]);
      await manage(true);
      expect(await preview()).toEqual([{ name: 'mcp_docs__search_docs', service: 'docs' }]);
      const session = await fixture.createSession();
      const response = await fixture.chat(session, '研究 MCP 文档中的 Watchlist');
      expect(response.status).toBe(200);
      const chunks = parse(await response.text());
      expect(chunks.filter((part) => part.type === 'error')).toEqual([]);
      expect(
        chunks.filter((part) => part.type === 'tool-input-available').map((part) => part.toolName),
      ).toEqual(['mcp_docs__search_docs']);
      expect(JSON.stringify(fixture.bodies)).toContain('CONTEXT.md');
      expect(
        chunks
          .filter((part) => part.type === 'text-delta')
          .map((part) => part.delta)
          .join(''),
      ).toContain('MCP 文档证据已核对完成');
      const before = fixture.bodies.length;
      await manage(false);
      expect(await preview()).toEqual([]);
      const second = await fixture.createSession();
      const disabled = parse(
        await (await fixture.chat(second, '研究 MCP 文档中的 Watchlist')).text(),
      );
      expect(disabled.filter((part) => part.type === 'error')).toEqual([]);
      expect(disabled.filter((part) => part.type === 'tool-input-available')).toEqual([]);
      expect(JSON.stringify(fixture.bodies.slice(before))).not.toContain('mcp_docs__search_docs');
      expect(
        disabled
          .filter((part) => part.type === 'text-delta')
          .map((part) => part.delta)
          .join(''),
      ).toContain('未启用');
    } finally {
      fixture.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
  it('revokes an already advertised tool before the running Agent dispatches it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-mcp-revoke-'));
    const config = join(root, 'mcp-servers.json');
    const service = {
      enabled: true,
      command: process.execPath,
      args: [
        '--no-env-file',
        fileURLToPath(new URL('../../../../packages/mcp/src/docs-server.ts', import.meta.url)),
      ],
      tools: ['search_docs'],
      scenarios: ['research'],
    };
    const save = (enabled: boolean) =>
      writeFileSync(
        config,
        JSON.stringify({ version: 1, services: { docs: { ...service, enabled } } }),
      );
    save(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createDshIntegrationFixture({
      externalMcpConfig: config,
      firstChunkGate: gate,
    });
    try {
      const response = await fixture.chat(
        await fixture.createSession(),
        '研究 MCP 文档中的 Watchlist',
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing chat stream');
      const decoder = new TextDecoder();
      let body = '';
      try {
        while (!body.includes('"type":"text-delta"')) {
          const next = await reader.read();
          if (next.done) throw new Error('Missing first model delta');
          body += decoder.decode(next.value, { stream: true });
        }
        expect(JSON.stringify(fixture.bodies[0])).toContain('mcp_docs__search_docs');
        save(false);
      } finally {
        release();
      }
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        body += decoder.decode(next.value, { stream: true });
      }
      const outputs = parse(body).filter((part) => part.type === 'tool-output-available');
      expect(outputs).toHaveLength(1);
      expect(outputs[0]?.output).toMatchObject({
        error: { message: 'Private endpoint rejected request (403)' },
      });
      expect(JSON.stringify(fixture.bodies.slice(1))).not.toContain('CONTEXT.md');
    } finally {
      release();
      fixture.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
