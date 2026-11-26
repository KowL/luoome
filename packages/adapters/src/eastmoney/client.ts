import {
  httpStatusErrorKind,
  isAbortError,
  isPluginExecutionDenial,
  SourceExecutionError,
} from '../source-error.js';

/**
 * Eastmoney 统一 HTTP 管道（docs/ddd/source-pluggability-and-observation-design.md §4.2/§4.4）。
 *
 * 只负责传输层：超时、HTTP 状态、JSON 解析；不烘焙任何端点（多个 API 族 base URL 不同），
 * 信封校验（rc / code / success / 日期错配）留在各领域解析函数。
 * 错误一律抛结构化 SourceExecutionError：主动超时 → timeout，fetch 拒绝 → network，
 * HTTP 状态按 httpStatusErrorKind，JSON 解析失败 → invalid_payload；registry 读 kind 做观测。
 */
export interface EastmoneyHttpOptions {
  readonly timeoutMs: number;
  /** 测试用：替换 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

const readJson = async (
  url: string,
  options: EastmoneyHttpOptions,
  init?: RequestInit,
): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await (options.fetchImpl ?? fetch)(url, {
      ...init,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new SourceExecutionError(
        httpStatusErrorKind(res.status),
        `HTTP ${res.status} ${res.statusText} url=${url}`,
      );
    }
    try {
      return (await res.json()) as unknown;
    } catch (error) {
      throw new SourceExecutionError(
        'invalid_payload',
        `JSON 解析失败: ${error instanceof Error ? error.message : String(error)} url=${url}`,
        error,
      );
    }
  } catch (error) {
    if (error instanceof SourceExecutionError || isPluginExecutionDenial(error)) throw error;
    throw new SourceExecutionError(
      isAbortError(error) ? 'timeout' : 'network',
      `fetch 失败: ${error instanceof Error ? error.message : String(error)} url=${url}`,
      error,
    );
  } finally {
    clearTimeout(timer);
  }
};

export const getJson = (url: string, options: EastmoneyHttpOptions): Promise<unknown> =>
  readJson(url, options);

/** 少数端点（股吧人气榜）只接受 POST JSON；其余语义与 getJson 一致。 */
export const postJson = (
  url: string,
  body: unknown,
  options: EastmoneyHttpOptions,
): Promise<unknown> =>
  readJson(url, options, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 股吧列表页是服务端渲染 HTML（内嵌 JSON）；只读文本，错误语义同 getJson。 */
export const getText = async (url: string, options: EastmoneyHttpOptions): Promise<string> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await (options.fetchImpl ?? fetch)(url, { signal: controller.signal });
    if (!res.ok) {
      throw new SourceExecutionError(
        httpStatusErrorKind(res.status),
        `HTTP ${res.status} ${res.statusText} url=${url}`,
      );
    }
    return await res.text();
  } catch (error) {
    if (error instanceof SourceExecutionError || isPluginExecutionDenial(error)) throw error;
    throw new SourceExecutionError(
      isAbortError(error) ? 'timeout' : 'network',
      `fetch 失败: ${error instanceof Error ? error.message : String(error)} url=${url}`,
      error,
    );
  } finally {
    clearTimeout(timer);
  }
};
