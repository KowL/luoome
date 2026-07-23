import { z } from 'zod';

import { AdshareError } from './errors.js';

const ConfigSchema = z.object({
  url: z
    .string()
    .min(1)
    .url()
    .transform((s) => s.replace(/\/$/, '')),
  apiKey: z.string().optional().default(''),
  timeoutMs: z.coerce.number().int().positive().optional().default(10_000),
  retries: z.coerce.number().int().nonnegative().optional().default(2),
});

export type AdshareConfig = z.infer<typeof ConfigSchema>;

/**
 * 从环境变量读取 Adshare 连接配置。
 * 远端 auth_enabled=true 时两者都必填；本地 mock 场景可用任意占位 key。
 */
export const fromEnv = (env: Record<string, string | undefined> = process.env): AdshareConfig => {
  const parsed = ConfigSchema.safeParse({
    url: env.ADSHARE_URL,
    apiKey: env.ADSHARE_API_KEY,
    timeoutMs: env.ADSHARE_TIMEOUT_MS,
    retries: env.ADSHARE_MAX_RETRIES,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new AdshareError('CONFIG_MISSING', `ADSHARE 配置缺失：${issues.join('; ')}`);
  }
  return parsed.data;
};
