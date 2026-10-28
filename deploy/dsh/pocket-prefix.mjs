import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: pocket-prefix.mjs <dsh-pocket/lib/proxy.mjs>');
  patchPocketProxy(process.argv[2]);
}
