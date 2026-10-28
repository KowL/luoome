import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const portOpen = (port) =>
  new Promise((done) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.destroy();
      done(true);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => done(false));
  });

export const probeListeners = async (dshPort = 3080, pocketPort = 3081) => {
  const [dsh, pocket] = await Promise.all([portOpen(dshPort), portOpen(pocketPort)]);
  return { dsh, pocket };
};

const socketProbe = (base, cookie) =>
  new Promise((done, reject) => {
    const request = (base.protocol === 'https:' ? httpsRequest : httpRequest)(
      new URL('api/remote.mux', base),
      {
        agent: false,
        headers: {
          Origin: base.origin,
          ...(cookie ? { Cookie: cookie } : {}),
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        },
      },
      (response) => {
        response.resume();
        done(response.statusCode);
      },
    );
    request.once('upgrade', (response, socket) => {
      socket.destroy();
      done(response.statusCode);
    });
    request.once('error', () => reject(new Error('Pocket probe: WebSocket connection failed')));
    request.setTimeout(8000, () => request.destroy(new Error('WebSocket timeout')));
    request.end();
  });

export const probePocket = async (baseUrl, pin) => {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.pathname !== '/dsh/')
    throw new Error('Pocket probe: expected an HTTP(S) /dsh/ entry');
  const cookies = new Map();
  const cookieHeader = () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  const target = (path) => {
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
      throw new Error('Pocket probe: redirect escaped /dsh/');
    return url;
  };
  const call = async (path, { body, authenticated = true, origin = base.origin } = {}) => {
    const response = await fetch(target(path), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        ...(authenticated ? { Cookie: cookieHeader() } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    for (const entry of response.headers.getSetCookie()) {
      const pair = entry.split(';')[0];
      const index = pair.indexOf('=');
      const key = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value) cookies.set(key, value);
      else cookies.delete(key);
    }
    return response;
  };
  const expectStatus = (response, expected, stage) => {
    if (response.status !== expected)
      throw new Error(`Pocket probe: ${stage} HTTP ${response.status}, expected ${expected}`);
  };

  const anonymous = await call('api/luoome/profile', { authenticated: false });
  expectStatus(anonymous, 401, 'unauthenticated API');
  await anonymous.body?.cancel();
  const login = await call('pocket-login', {
    body: new URLSearchParams({ token: pin }).toString(),
  });
  expectStatus(login, 302, 'password login');
  const location = login.headers.get('location');
  if (!location) throw new Error('Pocket probe: login did not redirect');
  await login.body?.cancel();
  let next = target(location);
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await call(next);
    const redirect = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && redirect) {
      next = target(redirect);
      await response.body?.cancel();
      continue;
    }
    expectStatus(response, 200, 'DSH handshake');
    await response.body?.cancel();
    break;
  }
  const shell = await call(base);
  expectStatus(shell, 200, 'DSH shell');
  await shell.body?.cancel();
  const profile = await call('api/luoome/profile');
  expectStatus(profile, 200, 'authenticated profile');
  if (!profile.headers.get('content-type')?.includes('application/json'))
    throw new Error('Pocket probe: profile returned a login page');
  const data = await profile.json();
  if (!Array.isArray(data.readTools)) throw new Error('Pocket probe: invalid luoome profile');
  const crossOrigin = await call('api/luoome/profile', { origin: 'https://untrusted.invalid' });
  expectStatus(crossOrigin, 403, 'cross-origin API');
  await crossOrigin.body?.cancel();
  if ((await socketProbe(base, '')) !== 401)
    throw new Error('Pocket probe: unauthenticated WebSocket was accepted');
  if ((await socketProbe(base, cookieHeader())) !== 101)
    throw new Error('Pocket probe: authenticated WebSocket failed');
  return { profile: 200, anonymous: 401, crossOrigin: 403, webSocket: 101, entry: base.pathname };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--health') {
      const port = Number(process.env.DSH_PORT ?? 3080);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DSH_PORT');
      const result = await probeListeners(port);
      console.log(JSON.stringify(result));
      process.exitCode = result.dsh && result.pocket ? 0 : 1;
    } else {
      const [base, pinFile] = process.argv.slice(2);
      if (!base || !pinFile)
        throw new Error('Usage: dsh-web-probe.mjs <public /dsh/ URL> <PIN file>');
      console.log(JSON.stringify(await probePocket(base, readFileSync(pinFile, 'utf8').trim())));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
