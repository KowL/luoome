import { httpStatusErrorKind, isAbortError, SourceExecutionError } from '../source-error.js';
import { parseTushareEnvelopeRows } from './envelope.js';

/**
 * Tushare 官方 HTTP API 客户端（https://tushare.pro/document/1?doc_id=130）。
 *
 * 协议：POST `${url}`，JSON body `{api_name, token, params, fields}`，
 * 响应 `{code, msg, data: {fields, items}}`。
 * - 仅网络错误、超时与 5xx 重试（指数退避）；4xx 直接抛错。
 * - 抛出的错误统一为携带结构化 kind 的 SourceExecutionError，消息保留 `tushare ...`
 *   前缀（network / timeout / http / upstream_error / parse），观测层读 kind 不看消息。
 */

export interface TushareConfig {
  /** API 地址；默认 http://api.tushare.pro（可用 TUSHARE_URL 覆盖，如代理网关）。 */
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly retries: number;
}

export const TUSHARE_DEFAULT_URL = 'http://api.tushare.pro';

/** 从 env 解析；TUSHARE_TOKEN 缺失即抛错（启用 tushare 的硬前置）。 */
export const tushareConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): TushareConfig => {
  const token = env.TUSHARE_TOKEN?.trim();
  if (token === undefined || token.length === 0) {
    throw new Error('tushare config: TUSHARE_TOKEN 未配置');
  }
  const url = env.TUSHARE_URL?.trim();
  return {
    url: url === undefined || url.length === 0 ? TUSHARE_DEFAULT_URL : url,
    token,
    timeoutMs: 10_000,
    retries: 2,
  };
};

export type TushareParams = Readonly<Record<string, string | number | undefined>>;

/**
 * 调用 tushare 接口并返回行对象数组（fields 动态映射）。
 * fields 省略时不传 fields 参数（返回接口默认列）。
 */
export const tushareQuery = async (
  apiName: string,
  params: TushareParams,
  config: TushareConfig,
  fetchImpl: typeof fetch,
  fields?: readonly string[],
): Promise<Array<Record<string, unknown>>> => {
  const filteredParams: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) filteredParams[key] = value;
  }
  const body = JSON.stringify({
    api_name: apiName,
    token: config.token,
    params: filteredParams,
    ...(fields === undefined ? {} : { fields: fields.join(',') }),
  });

  const res = await postWithRetry(config, body, fetchImpl);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (error) {
    throw new SourceExecutionError(
      'invalid_payload',
      `tushare parse: 响应不是有效 JSON（${String(error)}）`,
      error,
    );
  }
  return parseTushareEnvelopeRows(raw);
};

const postWithRetry = async (
  config: TushareConfig,
  body: string,
  fetchImpl: typeof fetch,
): Promise<Response> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetchImpl(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (!res.ok && res.status >= 500 && attempt < config.retries) {
        await delay(200 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new SourceExecutionError(
          httpStatusErrorKind(res.status),
          `tushare http: 远端 ${res.status} ${text}`,
        );
      }
      return res;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.startsWith('tushare http')) throw error;
      if (attempt < config.retries) {
        await delay(200 * 2 ** attempt);
        continue;
      }
      if (isAbortError(error)) {
        throw new SourceExecutionError(
          'timeout',
          `tushare timeout: 远端请求超时（${config.timeoutMs}ms）`,
          error,
        );
      }
      throw new SourceExecutionError(
        'network',
        `tushare network: 远端请求失败：${String(error)}`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SourceExecutionError('network', `tushare network: 重试耗尽：${String(lastError)}`);
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
