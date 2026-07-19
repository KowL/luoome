/* apps/web/public/js/api.js —— 后端 HTTP API 客户端。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

/** localStorage 中的 token key（设置页生成）。 */
const TOKEN_KEY = 'luoome.token';

/** 读 token（无则返回空串）。 */
const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
};

/** 写 token。 */
const setToken = (token) => {
  try {
    if (token.length > 0) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 忽略：隐私模式或 quota */
  }
};

/**
 * 调用后端 API。
 * @param {string} path 路径（必须以 / 开头）
 * @param {RequestInit} [init] fetch init；body 已是 JSON 时无需再 stringify
 * @returns {Promise<{ok: boolean, data?: unknown, error?: object}>}
 */
const callApi = async (path, init) => {
  const headers = new Headers(init?.headers);
  const token = getToken();
  if (token.length > 0) headers.set('authorization', `Bearer ${token}`);
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  let response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (cause) {
    return { ok: false, error: { kind: 'adapter_error', cause: String(cause) } };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: { kind: 'internal', cause: `HTTP ${response.status}` } };
  }
  return body;
};

export { callApi, getToken, setToken, TOKEN_KEY };
