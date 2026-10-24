/**
 * DSH web 入口的协议层连通性检查：HTTP 取会话 cookie，再用 WebSocket 连 RPC 通道。
 * 用法：bun dsh-web-probe.ts <baseUrl> <basicAuth> <token>
 */
const [baseUrl, basicAuth, token] = process.argv.slice(2);
if (!baseUrl || !basicAuth || !token) {
  console.error('usage: dsh-web-probe.ts <baseUrl> <basicAuth> <token>');
  process.exit(2);
}

const url = new URL(baseUrl);
const auth = Buffer.from(basicAuth).toString('base64');

let cookies: string[] = [];
let current = `${url.origin}${url.pathname}?token=${token}`;
let response = await fetch(current, {
  headers: { Authorization: `Basic ${auth}` },
  redirect: 'manual',
});
for (let hop = 0; hop < 3 && response.status >= 300 && response.status < 400; hop += 1) {
  cookies = [...cookies, ...(response.headers.getSetCookie?.() ?? [])];
  const location = response.headers.get('location');
  if (!location) break;
  current = new URL(location, current).toString();
  response = await fetch(current, {
    headers: { Authorization: `Basic ${auth}`, Cookie: cookies.join('; ') },
    redirect: 'manual',
  });
}
const cookie = [...cookies, ...(response.headers.getSetCookie?.() ?? [])]
  .map((entry) => entry.split(';')[0])
  .join('; ');
const body = await response.text();

console.log(
  JSON.stringify({
    step: 'http',
    status: response.status,
    bytes: body.length,
    hasCookie: cookie.length > 0,
    html: body.includes('<!doctype html') || body.includes('<html'),
  }),
);

if (response.status !== 200) process.exit(1);

const wsUrl = `ws://${url.host}${url.pathname.replace(/\/$/, '')}/api/remote.mux`;
const socket = new WebSocket(wsUrl, {
  headers: {
    Authorization: `Basic ${auth}`,
    Cookie: cookie,
    Origin: url.origin,
  },
});

const opened = await new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => resolve(false), 15_000);
  socket.addEventListener('open', () => {
    clearTimeout(timer);
    resolve(true);
  });
  socket.addEventListener('error', () => {
    clearTimeout(timer);
    resolve(false);
  });
});

console.log(JSON.stringify({ step: 'websocket', url: wsUrl, opened }));
socket.close();

// 面板服务端路由与浏览器端 bundle 是否真的上线。
for (const path of [
  '/api/luoome.panels/overview',
  '/api/luoome.panels/strategies',
  '/api/luoome.panels/review',
  '/plugins/??@luoome/dsh-panels/client.js',
]) {
  const probe = await fetch(`${url.origin}${url.pathname.replace(/\/$/, '')}${path}`, {
    headers: { Authorization: `Basic ${auth}`, Cookie: cookie },
  });
  const text = await probe.text();
  console.log(
    JSON.stringify({
      step: 'route',
      path,
      status: probe.status,
      bytes: text.length,
    }),
  );
}

process.exit(opened ? 0 : 1);
