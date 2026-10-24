/* apps/web/public/js/api.js —— 后端 HTTP API 客户端。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

/** localStorage 中的当前账户 id key（v0.5 W3 多账户切换）。 */
const ACCOUNT_KEY = 'luoome.accountId';
/** 身份版本：账户切换时递增，用于丢弃切换前发出的旧响应。 */
let identityEpoch = 0;

export const randomRequestId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // HTTP 临时入口仍可使用 getRandomValues，但浏览器不会提供 randomUUID。
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** 读当前账户 id（无则返回空串）。 */
const getAccountId = () => {
  try {
    return localStorage.getItem(ACCOUNT_KEY) ?? '';
  } catch {
    return '';
  }
};

/** 写当前账户 id。 */
const setAccountId = (accountId) => {
  const previousAccountId = getAccountId();
  try {
    if (accountId.length > 0) localStorage.setItem(ACCOUNT_KEY, accountId);
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    /* 忽略：隐私模式或 quota */
  }
  if (previousAccountId !== accountId) {
    identityEpoch += 1;
    globalThis.document?.dispatchEvent?.(new Event('luoome:identity-cleared'));
  }
};

/** 身份版本：账户切换后递增，旧响应据此作废。 */
const getIdentityEpoch = () => identityEpoch;

const apiHeaders = (init, accountId = getAccountId()) => {
  const headers = new Headers(init);
  if (!headers.has('x-luoome-account-id')) {
    headers.set('x-luoome-account-id', accountId);
  }
  return headers;
};

/**
 * 调用后端 API。
 * @param {string} path 路径（必须以 / 开头）
 * @param {RequestInit & { timeoutMs?: number }} [init] fetch init；body 已是 JSON 时无需再 stringify；
 * 仅显式传 timeoutMs 时挂超时（LLM 分析 / 数据同步等长调用默认不应被打断）
 * @returns {Promise<{ok: boolean, data?: unknown, error?: object}>}
 */
const callApi = async (path, init) => {
  const { timeoutMs, ...rest } = init ?? {};
  const headers = apiHeaders(rest.headers);
  if (rest.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  let response;
  try {
    response = await fetch(path, {
      ...rest,
      headers,
      signal:
        timeoutMs === undefined
          ? rest.signal
          : rest.signal
            ? AbortSignal.any([rest.signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const kind =
      cause instanceof DOMException &&
      (cause.name === 'TimeoutError' || cause.name === 'AbortError')
        ? 'timeout'
        : 'adapter_error';
    return { ok: false, error: { kind, cause: String(cause) } };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: { kind: 'internal', cause: `HTTP ${response.status}` } };
  }
  return body;
};

export { ACCOUNT_KEY, apiHeaders, callApi, getAccountId, getIdentityEpoch, setAccountId };
