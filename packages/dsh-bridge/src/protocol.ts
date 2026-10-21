import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
const IdSchema = z.string().min(1).max(256);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const VersionSchema = z.literal(PROTOCOL_VERSION);
const TimestampSchema = z.iso.datetime({ offset: true });

export const ToolManifestEntrySchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/),
  description: z.string().min(1).max(16000),
  inputSchema: JsonObjectSchema,
  callMode: z.enum(['execute', 'draft']),
  domain: IdSchema,
  sourcePlugin: IdSchema,
  executionLocation: z.enum(['bun-gateway', 'runtime-native']),
  sideEffect: z.enum(['read', 'advice', 'write', 'external']),
  requiredCapabilities: z.array(IdSchema).max(64),
  costPolicy: z.enum(['business-ledger', 'free', 'metered']),
});
export type ToolManifestEntry = z.infer<typeof ToolManifestEntrySchema>;

export const WEB_FETCH_MANIFEST_ENTRY: ToolManifestEntry = {
  name: 'web_fetch',
  description: 'Fetch the content of a specific HTTP(S) URL and return it decoded to text.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'The HTTP(S) URL to fetch.' } },
    required: ['url'],
  },
  callMode: 'execute',
  domain: 'web',
  sourcePlugin: '@deepseek-ai/dsh-tool-web',
  executionLocation: 'runtime-native',
  sideEffect: 'read',
  requiredCapabilities: ['web.fetch'],
  costPolicy: 'free',
};

export const ToolManifestSchema = z
  .strictObject({
    protocolVersion: VersionSchema,
    manifestHash: HashSchema,
    tools: z.array(ToolManifestEntrySchema).max(128),
  })
  .refine(
    (manifest) => new Set(manifest.tools.map((tool) => tool.name)).size === manifest.tools.length,
    {
      message: 'Duplicate tool names are forbidden',
      path: ['tools'],
    },
  );
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

export const RuntimeBindingSchema = z.strictObject({
  runtimeInstanceId: IdSchema,
  sessionId: IdSchema,
  profileHash: HashSchema,
  configHash: HashSchema,
  runId: IdSchema,
  conversationId: IdSchema,
});
export type RuntimeBinding = z.infer<typeof RuntimeBindingSchema>;

export const RunRequestSchema = z
  .strictObject({
    protocolVersion: VersionSchema,
    runId: IdSchema,
    conversationId: IdSchema,
    manifestHash: HashSchema,
    manifest: ToolManifestSchema,
    configRef: IdSchema,
    instructions: z.string().max(128000),
    prompt: z.string().min(1).max(256000),
    expiresAt: TimestampSchema,
  })
  .refine((request) => request.manifestHash === request.manifest.manifestHash, {
    message: 'Run and manifest hashes must match',
    path: ['manifestHash'],
  });
export type RunRequest = z.infer<typeof RunRequestSchema>;

export const ToolCallSchema = z.strictObject({
  protocolVersion: VersionSchema,
  runId: IdSchema,
  callId: IdSchema,
  toolName: IdSchema,
  input: JsonValueSchema,
  manifestHash: HashSchema,
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

// Callable output stays opaque: output.error and __luoomeDraft are business facts.
export const ToolReplySchema = z.strictObject({
  protocolVersion: VersionSchema,
  runId: IdSchema,
  callId: IdSchema,
  ok: z.boolean(),
  output: JsonValueSchema,
  auditRef: IdSchema.optional(),
});
export type ToolReply = z.infer<typeof ToolReplySchema>;

export const RunStatusSchema = z.enum([
  'preparing',
  'running',
  'stopping',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'unresolved',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const TerminalStatusSchema = RunStatusSchema.exclude(['preparing', 'running', 'stopping']);
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;

export const ProtocolErrorSchema = z.strictObject({
  code: z.enum([
    'invalid_request',
    'permission_denied',
    'manifest_mismatch',
    'runtime_unavailable',
    'runtime_failed',
    'timeout',
    'cancelled',
    'unresolved',
  ]),
  message: z.string().min(1).max(4000),
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export const RuntimeEventSchema = z.strictObject({
  protocolVersion: VersionSchema,
  runId: IdSchema,
  conversationId: IdSchema,
  agentId: IdSchema,
  parentAgentId: IdSchema.optional(),
  source: z.enum(['host', 'sdk', 'plugin', 'gateway']),
  sourceEventId: IdSchema,
  sequence: z.number().int().nonnegative(),
  timestamp: TimestampSchema,
  type: z.enum([
    'run.started',
    'run.status',
    'run.terminal',
    'text.delta',
    'assistant.message',
    'tool.call',
    'tool.result',
    'native-tool.result',
    'diagnostic',
  ]),
  payload: JsonObjectSchema,
});
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export const CancelRequestSchema = z.strictObject({
  protocolVersion: VersionSchema,
  runId: IdSchema,
  reason: z.enum(['user', 'disconnect', 'timeout', 'shutdown']),
});
export type CancelRequest = z.infer<typeof CancelRequestSchema>;

export const HostCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('run'), request: RunRequestSchema }),
  z.strictObject({ type: z.literal('cancel'), request: CancelRequestSchema }),
  z.strictObject({ type: z.literal('shutdown') }),
]);
export type HostCommand = z.infer<typeof HostCommandSchema>;

export const HostMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('ready'),
    protocolVersion: VersionSchema,
    runtimeInstanceId: IdSchema,
    pid: z.number().int().positive(),
    nodeVersion: z.string(),
  }),
  z.strictObject({ type: z.literal('binding'), binding: RuntimeBindingSchema }),
  z.strictObject({ type: z.literal('event'), event: RuntimeEventSchema }),
  z.strictObject({
    type: z.literal('error'),
    runId: IdSchema.optional(),
    error: ProtocolErrorSchema,
  }),
  z.strictObject({ type: z.literal('closed'), stopped: z.boolean() }),
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`)
    .join(',')}}`;
}
