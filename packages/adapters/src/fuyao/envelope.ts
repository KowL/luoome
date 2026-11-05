import { ZodError, z } from 'zod';

import { invalidPayloadError, noDataError, SourceExecutionError } from '../source-error.js';

/**
 * fuyao 统一响应信封 ApiResponse（https://fuyao.aicubes.cn/docs/api-reference/overview）。
 *
 * 所有业务结果（含错误）HTTP 恒 200，按信封 code 分发：
 * - code !== 0 → fuyaoErrorKindOf 映射的结构化 SourceExecutionError；
 * - code === 0 且 data === null → no_data；
 * - 信封形状不符（非 JSON 由 client 更早拦截）→ invalid_payload。
 *
 * parseFuyaoEnvelope 保留现有行情 item[] 语义；getData() 返回的未知形状 data
 * 由各领域用 Zod 自行校验。
 */

const FuyaoItemsDataSchema = z.object({
  // 快照无有效数据时 timestamp 为 null（上游文档口径），归一为 undefined。
  timestamp: z.number().nullish(),
  item: z.array(z.record(z.string(), z.unknown())),
});

const FuyaoEnvelopeSchema = z.object({
  code: z.number().int(),
  message: z.string().nullish().default(''),
  request_id: z.string().nullish(),
  data: FuyaoItemsDataSchema.nullable(),
});

export interface FuyaoEnvelopeData {
  /** 上游数据就绪时间（data.timestamp 毫秒戳）；上游给 null 时为 undefined。 */
  readonly timestamp: Date | undefined;
  readonly items: Array<Record<string, unknown>>;
  readonly requestId: string | undefined;
}

/** fuyao 业务错误码 → SourceErrorKind（设计文档 §5.9；1001-1004 是 adapter 自身 bug 的兜底归类）。 */
export const fuyaoErrorKindOf = (
  code: number,
): 'no_data' | 'unsupported_market' | 'rate_limited' | 'permission' | 'upstream_error' => {
  if (code === 3001 || code === 3002) return 'no_data';
  if (code === 3004) return 'unsupported_market';
  if (code === 4001) return 'rate_limited';
  if (code === 2001 || code === 2003) return 'permission';
  return 'upstream_error'; // 1001-1004 参数错 / 5001-5003 上游故障 / 未知码
};

/**
 * 行情 item[] data 解析：供 FuyaoClient.get() 在 getData 已拆信封（code 分发、
 * data===null → no_data 均已完成）之后调用，只校验 { timestamp, item[] } 形状，
 * 不重复解析信封。data 形状不符 → invalid_payload。
 */
export const parseFuyaoItemsData = (data: unknown, requestId?: string): FuyaoEnvelopeData => {
  let parsed: z.infer<typeof FuyaoItemsDataSchema>;
  try {
    parsed = FuyaoItemsDataSchema.parse(data);
  } catch (error) {
    if (error instanceof ZodError) {
      throw invalidPayloadError(`fuyao parse: data 形状不符（${error.message}）`, error);
    }
    throw error;
  }
  return {
    timestamp: parsed.timestamp == null ? undefined : new Date(parsed.timestamp),
    items: parsed.item,
    requestId,
  };
};

/**
 * 完整信封解析：code !== 0 按映射抛错；code === 0 且 data === null 抛 no_data。
 * 保留给直接持有原始响应体的调用方（测试、dump 等离线校验）使用；
 * FuyaoClient.get() 走 getData + parseFuyaoItemsData，不经过本函数。
 */
export const parseFuyaoEnvelope = (raw: unknown, requestId?: string): FuyaoEnvelopeData => {
  let env: z.infer<typeof FuyaoEnvelopeSchema>;
  try {
    env = FuyaoEnvelopeSchema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw invalidPayloadError(`fuyao parse: 信封形状不符（${error.message}）`, error);
    }
    throw error;
  }
  if (env.code !== 0) {
    const suffix = env.request_id == null ? '' : ` request_id=${env.request_id}`;
    throw new SourceExecutionError(
      fuyaoErrorKindOf(env.code),
      `fuyao ${fuyaoErrorKindOf(env.code)}: code=${env.code} ${env.message ?? ''}${suffix}`.trim(),
    );
  }
  if (env.data === null) {
    throw noDataError(`fuyao no_data: data 为 null（${env.message ?? ''}）`.trim());
  }
  return {
    timestamp: env.data.timestamp == null ? undefined : new Date(env.data.timestamp),
    items: env.data.item,
    requestId: requestId ?? env.request_id ?? undefined,
  };
};
