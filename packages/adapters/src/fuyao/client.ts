import { httpStatusErrorKind, isAbortError, SourceExecutionError } from '../source-error.js';
import { type FuyaoEnvelopeData, parseFuyaoEnvelope } from './envelope.js';

/**
 * fuyao REST 客户端（https://fuyao.aicubes.cn）。
 *
 * 协议：GET `${baseUrl}${path}?<query>`，请求头 `X-api-key` 鉴权；
 * 响应 HTTP 恒 200，业务结果按信封 code 分发（envelope.ts）。
 * - 超时走 AbortController；4001（频率超限）退避重试一次，仍失败抛 rate_limited；
 *   其余信封错误不重试（参数错 / 权限 / no_data 重试无意义）。
 * - 错误一律抛结构化 SourceExecutionError：网络 → network，主动超时 → timeout，
 *   非 200 → httpStatusErrorKind，JSON 解析失败 → invalid_payload。
 * - API key 只在请求头出现，任何日志与错误消息不得输出 key 本身。
 */

export interface FuyaoConfig {
  /** API 地址；默认 https://fuyao.aicubes.cn（可用 FUYAO_BASE_URL 覆盖）。 */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  /** 4001 退避重试次数（对齐设计文档 §5.9「内置退避重试一次」）。 */
  readonly retries: number;
}

export const FUYAO_DEFAULT_BASE_URL = 'https://fuyao.aicubes.cn';

/** 从 env 解析；FUYAO_API_KEY 缺失即抛错（启用 fuyao 的硬前置，由 factory 触发快速失败）。 */
export const fuyaoConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): FuyaoConfig => {
  const apiKey = env.FUYAO_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('fuyao config: FUYAO_API_KEY 未配置');
  }
  const baseUrl = env.FUYAO_BASE_URL?.trim();
  return {
    baseUrl: baseUrl === undefined || baseUrl.length === 0 ? FUYAO_DEFAULT_BASE_URL : baseUrl,
    apiKey,
    timeoutMs: 10_000,
    retries: 1,
  };
};

export interface FuyaoClientOptions {
  /** 测试用：替换 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

const RATE_LIMIT_BACKOFF_MS = 500;

export class FuyaoClient {
  private readonly config: FuyaoConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: FuyaoConfig, options: FuyaoClientOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** GET 并解析信封；4001 退避重试 config.retries 次后仍失败则抛出。 */
  async get(
    path: string,
    params: Readonly<Record<string, string | number>>,
  ): Promise<FuyaoEnvelopeData> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      query.set(key, String(value));
    }
    const url = `${this.config.baseUrl}${path}?${query.toString()}`;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.retries; attempt += 1) {
      try {
        return await this.getOnce(url);
      } catch (error) {
        lastError = error;
        const rateLimited = error instanceof SourceExecutionError && error.kind === 'rate_limited';
        if (!rateLimited || attempt >= this.config.retries) throw error;
        await delay(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
      }
    }
    throw lastError;
  }

  private async getOnce(url: string): Promise<FuyaoEnvelopeData> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'X-api-key': this.config.apiKey },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new SourceExecutionError(
          httpStatusErrorKind(res.status),
          `fuyao http: 远端 ${res.status} ${res.statusText} url=${url}`,
        );
      }
      let raw: unknown;
      try {
        raw = await res.json();
      } catch (error) {
        throw new SourceExecutionError(
          'invalid_payload',
          `fuyao parse: 响应不是有效 JSON（${error instanceof Error ? error.message : String(error)}）url=${url}`,
          error,
        );
      }
      return parseFuyaoEnvelope(raw);
    } catch (error) {
      if (error instanceof SourceExecutionError) throw error;
      throw new SourceExecutionError(
        isAbortError(error) ? 'timeout' : 'network',
        `fuyao ${isAbortError(error) ? 'timeout' : 'network'}: 请求失败（${error instanceof Error ? error.message : String(error)}）url=${url}`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
