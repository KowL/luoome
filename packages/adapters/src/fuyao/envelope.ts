import { ZodError, z } from 'zod';

import { invalidPayloadError, noDataError, SourceExecutionError } from '../source-error.js';

/**
 * fuyao 统一响应信封 ApiResponse（https://fuyao.aicubes.cn/docs/api-reference/overview）。
 *
 * 所有业务结果（含错误）HTTP 恒 200，按信封 code 分发：
 * - code !== 0 → fuyaoErrorKindOf 映射的结构化 SourceExecutionError；
 * - code === 0 且 data === null → no_data；
 * - 信封形状不符（非 JSON 由 client 更早拦截）→ invalid_payload。
 */

const FuyaoEnvelopeSchema = z.object({
  code: z.number().int(),
  message: z.string().nullish().default(''),
  request_id: z.string().nullish(),
  data: z
    .object({
      // 快照无有效数据时 timestamp 为 null（上游文档口径），归一为 undefined。
      timestamp: z.number().nullish(),
      item: z.array(z.record(z.string(), z.unknown())),
    })
    .nullable(),
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

/** 信封解析：code !== 0 按映射抛错；code === 0 且 data === null 抛 no_data。 */
export const parseFuyaoEnvelope = (raw: unknown): FuyaoEnvelopeData => {
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
    const requestId = env.request_id == null ? '' : ` request_id=${env.request_id}`;
    throw new SourceExecutionError(
      fuyaoErrorKindOf(env.code),
      `fuyao ${fuyaoErrorKindOf(env.code)}: code=${env.code} ${env.message ?? ''}${requestId}`.trim(),
    );
  }
  if (env.data === null) {
    throw noDataError(`fuyao no_data: data 为 null（${env.message ?? ''}）`.trim());
  }
  return {
    timestamp: env.data.timestamp == null ? undefined : new Date(env.data.timestamp),
    items: env.data.item,
    requestId: env.request_id ?? undefined,
  };
};
