import { z } from 'zod';

/**
 * 数据源可插拔与统一观测的共享端口（docs/ddd/source-pluggability-and-observation-design.md §4.4/§4.5）。
 * core 只定义词表与状态形状；执行错误载体（SourceExecutionError）与 registry 在 adapters。
 */

/** 数据源标识：小写字母 / 数字 / 连字符的非空串。 */
export const SourceIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/, 'source id 只允许小写字母、数字与连字符');
export type SourceId = z.infer<typeof SourceIdSchema>;

/** 源执行失败的统一词表；观测与状态读模型的唯一来源。 */
export const SourceErrorKindSchema = z.enum([
  'network',
  'timeout',
  'rate_limited',
  'permission',
  'no_data',
  'partial_data',
  'invalid_payload',
  'unsupported_market',
  'unsupported_capability',
  'unsupported_adjustment',
  'upstream_error',
]);
export type SourceErrorKind = z.infer<typeof SourceErrorKindSchema>;

/**
 * 单个 (source, dataset) 的进程内健康观测（内存态，重启归零）。
 * dataset / coverage 是开放字符串；领域侧（如 MarketSourceStatus）可收窄。
 */
export interface SourceStatus {
  readonly dataset: string;
  readonly source: string;
  readonly coverage: readonly string[];
  readonly capabilityEnabled: boolean;
  readonly configurationReady: boolean;
  readonly lastAttemptAt?: Date;
  readonly lastSuccessAt?: Date;
  readonly dataAsOf?: Date;
  readonly lastErrorKind?: SourceErrorKind;
}
