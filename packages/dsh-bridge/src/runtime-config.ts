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

export const HostConfigSchema = z.strictObject({
  configRef: z.string().min(1),
  gateway: AuthenticatedEndpointSchema,
  model: AuthenticatedEndpointSchema.extend({
    model: z.string().min(1),
    maxTokens: z.number().int().positive().max(65536).default(4096),
    contextWindow: z.number().int().positive().default(128000),
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
