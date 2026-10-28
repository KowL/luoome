import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeListeners, probePocket } from './dsh-web-probe.mjs';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

const listen = async (server: Server | ReturnType<typeof createTcpServer>, port = 0) => {
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing test port');
  return address.port;
};

const pocket = async (upstreamAvailable: boolean) => {
  const server = createServer((request, response) => {
    const authenticated = request.headers.cookie?.includes('probe-session=ready');
    if (request.url === '/dsh/api/luoome/profile') {
      const status = !authenticated
        ? 401
        : request.headers.origin === 'https://untrusted.invalid'
          ? 403
          : upstreamAvailable
            ? 200
            : 502;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status === 200 ? { readTools: [] } : { error: 'unavailable' }));
    } else if (request.url === '/dsh/pocket-login') {
      request.resume();
      request.once('end', () => {
        response.writeHead(302, {
          location: '/dsh/?dsh-pocket-auth=1',
          'set-cookie': ['probe-session=; Path=/; Max-Age=0', 'probe-session=ready; Path=/dsh/'],
        });
        response.end();
      });
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Pocket login or DSH shell</title>');
    }
  });
  server.on('upgrade', (request, socket) => {
    socket.once('end', () => socket.destroy());
    if (!request.headers.cookie?.includes('probe-session=ready'))
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    else
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
  });
  const port = await listen(server);
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  return `http://127.0.0.1:${port}/dsh/`;
};

describe('Pocket deployment probe', () => {
  it('does not accept a 200 password page when the DSH upstream is unavailable', async () => {
    const base = await pocket(false);
    expect((await fetch(base)).status).toBe(200);
    await expect(probePocket(base, 'FixturePassword')).rejects.toThrow(
      'authenticated profile HTTP 502',
    );
  });

  it('requires authenticated profile and WebSocket access, and rejects unauthenticated requests', async () => {
    expect(await probePocket(await pocket(true), 'FixturePassword')).toEqual({
      profile: 200,
      anonymous: 401,
      crossOrigin: 403,
      webSocket: 101,
      entry: '/dsh/',
    });
  });

  it('marks a running Pocket unhealthy until the DSH loopback listener is available', async () => {
    const upstream = createTcpServer((socket) => socket.destroy());
    const proxy = createTcpServer((socket) => socket.destroy());
    const dshPort = await listen(upstream);
    await new Promise<void>((done) => upstream.close(() => done()));
    const pocketPort = await listen(proxy);
    try {
      expect(await probeListeners(dshPort, pocketPort)).toEqual({ dsh: false, pocket: true });
      await listen(upstream, dshPort);
      expect(await probeListeners(dshPort, pocketPort)).toEqual({ dsh: true, pocket: true });
    } finally {
      await Promise.all([
        new Promise<void>((done) => upstream.close(() => done())),
        new Promise<void>((done) => proxy.close(() => done())),
      ]);
    }
  });
});
