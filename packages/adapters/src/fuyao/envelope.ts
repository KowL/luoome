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
    })
    .passthrough()
    .nullable(),
});

export interface FuyaoDataEnvelope {
  /** 上游数据就绪时间（data.timestamp 毫秒戳）；上游给 null 时为 undefined。 */
  readonly timestamp: Date | undefined;
  /** data 对象原样（非 item 形状的端点自行 zod 解析；data=null 已被 no_data 拦截）。 */
  readonly data: Record<string, unknown>;
  readonly requestId: string | undefined;
}

/**
 * 解析「data 为对象」的信封（如龙虎榜 board 容器：data.stock_items，而非 data.item）。
 * 错误码 → 结构化 SourceExecutionError；data 缺失 → no_data；信封形状不符 → invalid_payload。
 */
export const parseFuyaoDataEnvelope = (raw: unknown): FuyaoDataEnvelope => {
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
    data: env.data,
    requestId: env.request_id ?? undefined,
  };
};

export interface FuyaoEnvelopeData {
  /** 上游数据就绪时间（data.timestamp 毫秒戳）；上游给 null 时为 undefined。 */
  readonly timestamp: Date | undefined;
  /** data.item 数组；端点不返回 item（如龙虎榜 board）时为空数组。 */
  readonly items: Array<Record<string, unknown>>;
  readonly requestId: string | undefined;
  /** data 对象原样：非 item 形状的端点（龙虎榜 board / 交易日历的附加字段）直接读它。 */
  readonly data: Record<string, unknown>;
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
  const { timestamp, data, requestId } = parseFuyaoDataEnvelope(raw);
  // data 没有 item 字段 → 非 item 形状的端点（如龙虎榜 board 的 stock_items）；
  // 保留 data 原样由调用方解析，items 退化为空数组而不是判成 invalid_payload。
  if (data.item === undefined) return { timestamp, items: [], requestId, data };
  const items = z.array(z.record(z.string(), z.unknown())).safeParse(data.item);
  if (!items.success) {
    throw invalidPayloadError(
      `fuyao parse: data.item 不是数组（${items.error.message}）`,
      items.error,
    );
  }
  return { timestamp, items: items.data, requestId, data };
};
