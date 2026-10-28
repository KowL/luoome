import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = '/dsh';

export const prefixPocketHeaders = (headers) => {
  const output = { ...headers };
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'location' && typeof value === 'string') {
      if (
        value.startsWith('/') &&
        !value.startsWith('//') &&
        value !== PREFIX &&
        !value.startsWith(`${PREFIX}/`) &&
        !value.startsWith(`${PREFIX}?`)
      )
        output[name] = `${PREFIX}${value}`;
    }
    if (name.toLowerCase() === 'set-cookie') {
      output[name] = (Array.isArray(value) ? value : [value]).flatMap((cookie) => {
        const scoped = cookie.replace(/(;\s*path=)\/(;|$)/i, `$1${PREFIX}/$2`);
        const cookieName = cookie.slice(0, cookie.indexOf('='));
        // 清除迁移前 Path=/ 的同名 cookie，避免浏览器同时发送新旧会话值。
        return [`${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`, scoped];
      });
    }
  }
  return output;
};

export const prefixPocketResponse = (response) => {
  const original = response.writeHead;
  response.writeHead = function (status, messageOrHeaders, headers) {
    if (typeof messageOrHeaders === 'string')
      return original.call(this, status, messageOrHeaders, prefixPocketHeaders(headers ?? {}));
    return original.call(this, status, prefixPocketHeaders(messageOrHeaders ?? {}));
  };
};

export const patchPocketProxy = (path) => {
  let source = readFileSync(path, 'utf8');
  // 重复安装时 npm 不会重装同版本包，补丁会被再打一次；这里按标记跳过。
  if (source.includes('prefixPocketResponse(res);')) return false;
  const substitutions = [
    [
      'const server = createServer((req, res) => {',
      'const server = createServer((req, res) => {\n    prefixPocketResponse(res);',
    ],
    ['action="/pocket-login"', `action="${PREFIX}/pocket-login"`],
    ['content="0; url=/"', `content="0; url=${PREFIX}/"`],
    [`<a href="/?\${HANDSHAKE_RETRY_PARAM}=1"`, `<a href="${PREFIX}/?\${HANDSHAKE_RETRY_PARAM}=1"`],
  ];
  for (const [before, after] of substitutions) {
    if (source.split(before).length !== 2)
      throw new Error(`Unsupported Pocket proxy layout: ${before}`);
    source = source.replace(before, after);
  }
  writeFileSync(
    path,
    `import { prefixPocketResponse } from ${JSON.stringify(import.meta.url)};\n${source}`,
  );
  return true;
};

// 插件模式把代理硬编码绑在 0.0.0.0（lib/service.mjs）。容器里由 bridge 网络兜住，
// 宿主机直部署时同一个端口会直接暴露到公网，所以改成可配、默认只绑 loopback。
export const patchPocketBindHost = (path) => {
  const source = readFileSync(path, 'utf8');
  if (source.includes('DSH_POCKET_BIND_HOST')) return false;
  const before = "host: '0.0.0.0',";
  const after = "host: process.env.DSH_POCKET_BIND_HOST ?? '127.0.0.1',";
  if (source.split(before).length !== 2)
    throw new Error(`Unsupported Pocket service layout: ${before}`);
  writeFileSync(path, source.replace(before, after));
  return true;
};

// 允许传包目录或包内文件：<pkg>/lib/proxy.mjs 反推回 <pkg>，两种入口打同一套补丁。
const resolvePackageDir = (input) => {
  const absolute = resolve(input);
  if (statSync(absolute).isDirectory()) return absolute;
  return resolve(absolute, '..', '..');
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2])
    throw new Error('Usage: pocket-prefix.mjs <dsh-pocket dir> | <dsh-pocket/lib/proxy.mjs>');
  const packageDir = resolvePackageDir(process.argv[2]);
  patchPocketProxy(join(packageDir, 'lib', 'proxy.mjs'));
  patchPocketBindHost(join(packageDir, 'lib', 'service.mjs'));
}
