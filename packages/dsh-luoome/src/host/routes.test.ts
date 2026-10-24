import { toolRegistry } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { createReadSurface } from './read-surface.js';
import { createReadCallHandler } from './routes.js';

const request = (
  body = '{"tool":"list_accounts","input":{}}',
  headers: Record<string, string> = {},
) =>
  new Request('https://dsh.example/api/luoome/call', {
    method: 'POST',
    headers: { origin: 'https://dsh.example', 'content-type': 'application/json', ...headers },
    body,
  });

const setup = async () => {
  const ctx = await buildTestContext();
  const context = vi.fn(() => ctx);
  const surface = createReadSurface({
    config: { allowlist: ['list_accounts', 'create_account'] },
    tools: toolRegistry.all(),
    context,
  });
  const admit = vi.fn(() => undefined);
  return { context, surface, admit, handle: createReadCallHandler(surface, admit) };
};

describe('authenticated read call route', () => {
  it('uses host admission and returns canonical JSON without caching', async () => {
    const { handle, admit } = await setup();
    const req = request();
    const response = await handle(req);
    expect(admit).toHaveBeenCalledWith(req);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('fails closed when host authentication rejects or throws', async () => {
    const { surface, context } = await setup();
    const rejected = new Response('unauthorized', { status: 401 });
    expect(await createReadCallHandler(surface, () => rejected)(request())).toBe(rejected);
    const response = await createReadCallHandler(surface, () => {
      throw new Error('secret');
    })(request());
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('secret');
    expect(context).not.toHaveBeenCalled();
  });

  it('rejects missing, foreign, and spoofed forwarded origins before acquiring context', async () => {
    const { handle, context } = await setup();
    for (const origin of ['', 'https://attacker.example']) {
      const response = await handle(
        request(undefined, { origin, 'x-forwarded-host': 'attacker.example' }),
      );
      expect(response.status).toBe(403);
    }
    const req = request();
    req.headers.delete('origin');
    expect((await handle(req)).status).toBe(403);
    expect(context).not.toHaveBeenCalled();
  });

  it('rejects write calls and forged approval or surface fields', async () => {
    const { handle, context } = await setup();
    expect((await handle(request('{"tool":"create_account","input":{}}'))).status).toBe(403);
    for (const extra of [{ approved: true }, { surface: 'settings' }]) {
      expect(
        (await handle(request(JSON.stringify({ tool: 'list_accounts', input: {}, ...extra }))))
          .status,
      ).toBe(400);
    }
    expect(context).not.toHaveBeenCalled();
  });

  it('bounds byte length, rejects invalid JSON and media types, and requires POST', async () => {
    const { handle, context } = await setup();
    expect((await handle(request('中'.repeat(23000)))).status).toBe(413);
    for (const text of ['', '[1]', '{', 'null'])
      expect((await handle(request(text))).status).toBe(400);
    expect((await handle(request(undefined, { 'content-type': 'text/plain' }))).status).toBe(415);
    const response = await handle(new Request('https://dsh.example/api/luoome/call'));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(context).not.toHaveBeenCalled();
  });

  it('rejects previously created handlers after the surface is disposed', async () => {
    const { handle, surface, context } = await setup();
    surface.dispose();
    expect((await handle(request())).status).toBe(403);
    expect(context).not.toHaveBeenCalled();
  });
});
