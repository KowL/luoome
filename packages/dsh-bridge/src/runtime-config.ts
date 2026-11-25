import { z } from 'zod';
import { RunRequestSchema } from './protocol.js';

export const PrivateEndpointSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  }, 'Expected an authenticated loopback HTTP endpoint');
export const AuthenticatedEndpointSchema = z.strictObject({
  endpoint: PrivateEndpointSchema,
  token: z.string().min(16).max(4096),
});

/** Agent profile 的推理强度；`off` 表示不向供应商发送任何推理参数。 */
export const ReasoningEffortSchema = z.enum(['off', 'low', 'medium', 'high', 'max']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const HostConfigSchema = z.strictObject({
  configRef: z.string().min(1),
  /** 持久会话根目录（绝对路径）；缺省时每次运行使用独立临时目录，不跨轮续接。 */
  sessionHome: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('/'), 'Expected an absolute session home')
    .optional(),
  gateway: AuthenticatedEndpointSchema,
  model: AuthenticatedEndpointSchema.extend({
    model: z.string().min(1),
    maxTokens: z.number().int().positive().max(65536).default(4096),
    contextWindow: z.number().int().positive().default(128000),
    /** 采样温度；缺省时不覆盖供应商默认值。 */
    temperature: z.number().min(0).max(2).optional(),
    reasoningEffort: ReasoningEffortSchema.default('off'),
  }),
  native: z
    .strictObject({
      authorization: AuthenticatedEndpointSchema,
      allowedOrigins: z.array(z.string().url()).max(32),
      maxCalls: z.number().int().nonnegative().max(32),
      // Explicit fixtures only; never an implicit fallback for a failed HTTP fetch.
      fixtures: z.record(z.string().url(), z.string().max(100000)).optional(),
    })
    .optional(),
  limits: z
    .strictObject({
      runTimeoutMs: z.number().int().min(100).max(600000).default(120000),
      toolTimeoutMs: z.number().int().min(100).max(60000).default(15000),
      initializeTimeoutMs: z.number().int().min(100).max(60000).default(15000),
      maxToolCalls: z.number().int().min(1).max(128).default(32),
      maxModelCalls: z.number().int().min(1).max(32).default(8),
      /** 单个子 Agent 从创建起的墙钟预算；到期只放弃该子 Agent，不改判整个 Run。 */
      subagentTimeoutMs: z.number().int().min(100).max(600000).default(60000),
      /**
       * 根 Agent 首次 idle 后，为处理子 Agent 完成/放弃通知最多再唤醒父级的轮次。
       * 每唤醒成功开一轮计一次；耗尽只做 abandoned 收尾，不把 Run 判失败。
       */
      parentFollowUpTurns: z.number().int().min(1).max(32).default(8),
    })
    .prefault({}),
});
export type HostConfig = z.infer<typeof HostConfigSchema>;

export const PluginConfigSchema = z.strictObject({
  host: HostConfigSchema,
  run: RunRequestSchema,
  sessionId: z.string().min(1),
  eventSink: AuthenticatedEndpointSchema,
});
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
