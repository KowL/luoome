import { httpStatusErrorKind, isAbortError, SourceExecutionError } from '../source-error.js';
import { type FuyaoEnvelopeData, fuyaoErrorKindOf, parseFuyaoItemsData } from './envelope.js';
import {
  FUYAO_REQUEST_COORDINATOR_DEFAULTS,
  FuyaoRequestCoordinator,
  type FuyaoRequestCoordinatorConfig,
  fuyaoRequestCoordinatorConfigFromEnv,
  isRetryableRateLimit,
  parseRetryAfterMs,
  rateLimitBackoffMs,
} from './request-coordinator.js';

/**
 * fuyao REST 客户端（https://fuyao.aicubes.cn）。
 *
 * 协议：GET `${baseUrl}${path}?<query>`，请求头 `X-api-key` 鉴权；
 * 响应 HTTP 恒 200，业务结果按信封 code 分发（envelope.ts）。
 * - 超时走 AbortController；429/4001 经共享协调器冷却后有界重试，仍失败抛 rate_limited；
 *   其余信封错误（2001/2003 权限、参数错、no_data）不做限流重试。
 * - 错误一律抛结构化 SourceExecutionError：网络 → network，主动超时 → timeout，
 *   非 200 → httpStatusErrorKind，JSON 解析失败 → invalid_payload。
 * - API key 只在请求头出现，任何日志与错误消息不得输出 key 本身。
 * - 新增 getData() 返回未知形状 data + requestId，供各领域用 Zod 自行校验；
 *   get() 保留现有 item[] 行情语义。
 */

export interface FuyaoConfig {
  /** API 地址；默认 https://fuyao.aicubes.cn（可用 FUYAO_BASE_URL 覆盖）。 */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  /** 4001/429 有界重试次数（对齐设计 §4.2，默认 2）。 */
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
    retries: fuyaoRequestCoordinatorConfigFromEnv(env).rateLimitMaxRetries,
  };
};

export interface FuyaoClientOptions {
  /** 测试用：替换 fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 共享请求协调器；缺省时按 config 创建进程内实例。 */
  readonly coordinator?: FuyaoRequestCoordinator;
  /** 协调器配置；仅当未注入 coordinator 时生效。 */
  readonly coordinatorConfig?: FuyaoRequestCoordinatorConfig;
  /** 日志回调；只接收脱敏字段（requestId、capability、耗时、错误 kind）。 */
  readonly logger?: FuyaoClientLogger;
  /** 测试用：替换时钟（与协调器共用，保证冷却/退避确定性）。 */
  readonly clock?: () => number;
  /** 测试用：替换 sleep（与协调器共用）。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface FuyaoClientLogEntry {
  readonly requestId?: string | undefined;
  readonly path: string;
  readonly durationMs: number;
  readonly errorKind?: string | undefined;
}

export type FuyaoClientLogger = (entry: FuyaoClientLogEntry) => void;

export interface FuyaoDataResult {
  readonly data: unknown;
  readonly requestId?: string | undefined;
}

const buildUrl = (
  baseUrl: string,
  path: string,
  params: Readonly<Record<string, string | number>>,
): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }
  return `${baseUrl}${path}?${query.toString()}`;
};

export class FuyaoClient {
  private readonly config: FuyaoConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly coordinator: FuyaoRequestCoordinator;
  private readonly logger: FuyaoClientLogger | undefined;
  private readonly clock: () => number;

  constructor(config: FuyaoConfig, options: FuyaoClientOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? ((): number => Date.now());
    this.coordinator =
      options.coordinator ??
      new FuyaoRequestCoordinator(
        options.coordinatorConfig ?? {
          ...FUYAO_REQUEST_COORDINATOR_DEFAULTS,
          rateLimitMaxRetries: config.retries,
        },
        {
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        },
      );
    this.logger = options.logger;
  }

  /**
   * GET 并解析为行情 item[] 语义；getData 已完成信封 code 分发与 data===null → no_data，
   * 这里只校验 { timestamp, item[] } 形状，不重复解析信封。
   */
  async get(
    path: string,
    params: Readonly<Record<string, string | number>>,
  ): Promise<FuyaoEnvelopeData> {
    const result = await this.getData(path, params);
    return parseFuyaoItemsData(result.data, result.requestId);
  }

  /**
   * 通用 GET：返回未知形状 data + requestId，由各领域用 Zod 自行校验。
   * 429/4001 的等待只发生一次：把 Retry-After（429）或 1s/5s 级退避（4001）写入
   * 共享协调器冷却窗口，重试提交后由协调器在冷却结束前暂停队列——client 不再单独 sleep。
   */
  async getData(
    path: string,
    params: Readonly<Record<string, string | number>>,
  ): Promise<FuyaoDataResult> {
    const url = buildUrl(this.config.baseUrl, path, params);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.retries; attempt += 1) {
      const startedAt = this.clock();
      try {
        const result = await this.coordinator.execute(() => this.getOnce(url, attempt));
        this.log({ path, durationMs: this.clock() - startedAt, requestId: result.requestId });
        return result;
      } catch (error) {
        lastError = error;
        this.log({
          path,
          durationMs: this.clock() - startedAt,
          errorKind: error instanceof SourceExecutionError ? error.kind : 'upstream_error',
        });
        if (!isRetryableRateLimit(error) || attempt >= this.config.retries) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private async getOnce(url: string, attempt: number): Promise<FuyaoDataResult> {
    let httpRateLimited = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'X-api-key': this.config.apiKey },
        signal: controller.signal,
      });
      if (!res.ok) {
        httpRateLimited = res.status === 429;
        const retryAfterMs =
          res.status === 429
            ? parseRetryAfterMs(res.headers.get('retry-after'), this.clock)
            : undefined;
        throw new SourceExecutionError(
          httpStatusErrorKind(res.status),
          `fuyao http: 远端 ${res.status} ${res.statusText} url=${url}`,
          undefined,
          retryAfterMs,
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
      return extractEnvelopeData(raw);
    } catch (error) {
      if (error instanceof SourceExecutionError) {
        if (error.kind === 'rate_limited') {
          // 在协调器释放并发槽位前暂停队列，重试耗尽也不能跳过共享冷却。
          this.coordinator.reportRateLimited(
            httpRateLimited ? error.retryAfterMs : rateLimitBackoffMs(attempt),
          );
        }
        throw error;
      }
      throw new SourceExecutionError(
        isAbortError(error) ? 'timeout' : 'network',
        `fuyao ${isAbortError(error) ? 'timeout' : 'network'}: 请求失败（${error instanceof Error ? error.message : String(error)}）url=${url}`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private log(entry: FuyaoClientLogEntry): void {
    this.logger?.(entry);
  }
}

/**
 * 从原始 JSON 提取信封 data 与 request_id；code !== 0 按映射抛错。
 * 与 parseFuyaoEnvelope 分离，让 getData 能返回任意形状 data。
 */
const extractEnvelopeData = (raw: unknown): FuyaoDataResult => {
  if (typeof raw !== 'object' || raw === null) {
    throw new SourceExecutionError('invalid_payload', 'fuyao parse: 信封形状不符（非对象）');
  }
  const envelope = raw as Record<string, unknown>;
  const code = envelope.code;
  if (typeof code !== 'number' || !Number.isInteger(code)) {
    throw new SourceExecutionError('invalid_payload', 'fuyao parse: 信封缺少有效 code');
  }
  const requestId = typeof envelope.request_id === 'string' ? envelope.request_id : undefined;
  if (code !== 0) {
    const message = typeof envelope.message === 'string' ? envelope.message : '';
    const kind = fuyaoErrorKindOf(code);
    const suffix = requestId === undefined ? '' : ` request_id=${requestId}`;
    // 4001 无 Retry-After 语义；retryAfterMs 留 undefined，由 getData 按 attempt 计算 1s/5s 级退避。
    throw new SourceExecutionError(kind, `fuyao ${kind}: code=${code} ${message}${suffix}`.trim());
  }
  const data = envelope.data;
  if (data === null) {
    throw new SourceExecutionError(
      'no_data',
      `fuyao no_data: data 为 null（${typeof envelope.message === 'string' ? envelope.message : ''}）`.trim(),
    );
  }
  return { data, requestId };
};

/** fuyao 业务错误码 → SourceErrorKind（设计文档 §5.9；1001-1004 是 adapter 自身 bug 的兜底归类）。 */
export { fuyaoErrorKindOf } from './envelope.js';
