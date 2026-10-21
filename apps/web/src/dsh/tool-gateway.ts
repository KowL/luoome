import type { ToolError } from '@luoome/core';
import {
  canonicalJson,
  type JsonValue,
  PROTOCOL_VERSION,
  type ProtocolError,
  type ToolCall,
  ToolCallSchema,
  type ToolManifestEntry,
  type ToolReply,
  ToolReplySchema,
} from '@luoome/dsh-bridge/protocol';
import {
  type GatewayCaller,
  GatewayExecutionScope,
  type GatewayScopeSnapshot,
} from './execution-scope.js';
import {
  encodeGatewayJson,
  type GatewayBoundTool,
  type GatewayCallableManifest,
  hashGatewayJson,
} from './tool-manifest.js';

export type GatewayExecutionResult =
  | { readonly kind: 'reply'; readonly reply: ToolReply; readonly replayed: boolean }
  | { readonly kind: 'rejected'; readonly error: ProtocolError };

export interface GatewayToolAuthorization {
  readonly scope: GatewayScopeSnapshot;
  readonly call: ToolCall;
  readonly tool: ToolManifestEntry;
  readonly signal: AbortSignal;
}

export type GatewayAuthorizer = (
  request: GatewayToolAuthorization,
) => ToolError | null | Promise<ToolError | null>;

export interface RegisterGatewayRun {
  readonly scope: GatewayScopeSnapshot;
  readonly manifest: GatewayCallableManifest;
  /** Recheck current tenant generation, ownership, entitlements and maintenance barriers. */
  readonly authorize: GatewayAuthorizer;
  /** Existing external/fee permission gate. It must not replace the business ledger. */
  readonly admitExternal?: GatewayAuthorizer;
  readonly abortSignal?: AbortSignal;
}

interface CallRecord {
  readonly fingerprint: string;
  readonly result: Promise<GatewayExecutionResult>;
  reply?: ToolReply;
}

interface GatewayRun {
  readonly scope: GatewayExecutionScope;
  readonly callables: ReadonlyMap<string, GatewayBoundTool>;
  readonly authorize: GatewayAuthorizer;
  readonly admitExternal: GatewayAuthorizer | undefined;
  readonly records: Map<string, CallRecord>;
  readonly inFlight: Set<Promise<unknown>>;
  readonly detachAbort: () => void;
}

export interface GatewayDrainResult {
  readonly drained: boolean;
  readonly activeCalls: number;
}

export interface ToolGatewayOptions {
  readonly clock?: () => number;
  readonly maxRuns?: number;
  readonly maxCallsPerRun?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly callTimeoutMs?: number;
}

const rejected = (code: ProtocolError['code'], message: string): GatewayExecutionResult => ({
  kind: 'rejected',
  error: { code, message },
});

const denied = (): GatewayExecutionResult =>
  rejected('permission_denied', 'Tool execution is not authorized for this active scope.');

const freezeJson = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
};

export class ToolGateway {
  readonly #runs = new Map<string, GatewayRun>();
  readonly #clock: () => number;
  readonly #limits: Required<Omit<ToolGatewayOptions, 'clock'>>;

  constructor(options: ToolGatewayOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#limits = {
      maxRuns: options.maxRuns ?? 128,
      maxCallsPerRun: options.maxCallsPerRun ?? 256,
      maxInputBytes: options.maxInputBytes ?? 128_000,
      maxOutputBytes: options.maxOutputBytes ?? 1_000_000,
      callTimeoutMs: options.callTimeoutMs ?? 30_000,
    };
    if (Object.values(this.#limits).some((limit) => !Number.isSafeInteger(limit) || limit <= 0)) {
      throw new Error('Gateway limits must be positive safe integers');
    }
  }

  register(options: RegisterGatewayRun): GatewayScopeSnapshot {
    const { scope, manifest } = options;
    if (
      this.#runs.has(scope.runId) ||
      this.#runs.size >= this.#limits.maxRuns ||
      scope.manifestHash !== manifest.manifest.manifestHash ||
      scope.scenario !== manifest.scenario ||
      !Number.isFinite(scope.expiresAt) ||
      scope.expiresAt <= this.#clock()
    ) {
      throw new Error('Gateway run registration is invalid or unavailable');
    }
    const execution = new GatewayExecutionScope(scope);
    const abort = () => execution.revoke();
    options.abortSignal?.addEventListener('abort', abort, { once: true });
    if (options.abortSignal?.aborted) abort();
    this.#runs.set(scope.runId, {
      scope: execution,
      callables: new Map(
        [...manifest.callables].map(([name, tool]) => [
          name,
          {
            ...tool,
            declaration: freezeJson(structuredClone(tool.declaration)),
          },
        ]),
      ),
      authorize: options.authorize,
      admitExternal: options.admitExternal,
      records: new Map(),
      inFlight: new Set(),
      detachAbort: () => options.abortSignal?.removeEventListener('abort', abort),
    });
    return execution.snapshot;
  }

  async execute(caller: GatewayCaller, request: unknown): Promise<GatewayExecutionResult> {
    let bounded: unknown;
    try {
      bounded = JSON.parse(encodeGatewayJson(request, this.#limits.maxInputBytes));
    } catch {
      return rejected('invalid_request', 'Tool request exceeds the JSON boundary limits.');
    }
    const parsed = ToolCallSchema.safeParse(bounded);
    if (!parsed.success)
      return rejected('invalid_request', 'Tool request does not match protocol v1.');
    const call = freezeJson(parsed.data);
    const run = this.#runs.get(call.runId);
    if (run === undefined || run.scope.check(caller, this.#clock()) !== null) return denied();
    if (call.manifestHash !== run.scope.snapshot.manifestHash) {
      return rejected('manifest_mismatch', 'Tool request does not match the registered manifest.');
    }
    // Trusted admission callbacks may synchronously revoke and attempt to release this run.
    const work = Promise.resolve().then(() => this.#execute(run, caller, call));
    run.inFlight.add(work);
    void work.finally(() => run.inFlight.delete(work));
    return this.#wait(work, run.scope.signal);
  }

  async #execute(
    run: GatewayRun,
    caller: GatewayCaller,
    call: ToolCall,
  ): Promise<GatewayExecutionResult> {
    try {
      if (run.scope.check(caller, this.#clock()) !== null) return denied();
      const tool = run.callables.get(call.toolName);
      if (tool === undefined) return denied();
      const scope = run.scope.snapshot;
      if (
        !tool.declaration.requiredCapabilities.every((cap) =>
          scope.allowedCapabilities.some((allowed) => allowed === cap),
        )
      ) {
        return denied();
      }
      const input = call.input;
      if (
        input !== null &&
        !Array.isArray(input) &&
        typeof input === 'object' &&
        Object.hasOwn(input, 'accountId') &&
        input.accountId !== scope.accountId
      )
        return denied();
      const authorization = { scope, call, tool: tool.declaration, signal: run.scope.signal };
      const fingerprint = hashGatewayJson(
        canonicalJson({
          toolName: call.toolName,
          manifestHash: call.manifestHash,
          input,
        }),
      );
      const existing = run.records.get(call.callId);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          return rejected('invalid_request', 'callId is already bound to another tool or input.');
        }
        if ((await run.authorize(authorization)) !== null) return denied();
        if (run.scope.check(caller, this.#clock()) !== null) return denied();
        const result = await existing.result;
        return result.kind === 'reply' ? { ...result, replayed: true } : result;
      }
      if (run.records.size >= this.#limits.maxCallsPerRun) {
        return rejected('runtime_unavailable', 'Run tool-call limit reached.');
      }
      let complete!: (result: GatewayExecutionResult) => void;
      const record: CallRecord = {
        fingerprint,
        result: new Promise((resolve) => {
          complete = resolve;
        }),
      };
      // Reserve before asynchronous authorization so a rejected identity cannot change its input.
      run.records.set(call.callId, record);
      const result = await this.#invoke(run, caller, tool, authorization);
      if (result.kind === 'reply') record.reply = result.reply;
      complete(result);
      return result;
    } catch {
      return rejected('runtime_failed', 'Gateway authorization or execution failed.');
    }
  }

  async #invoke(
    run: GatewayRun,
    caller: GatewayCaller,
    tool: GatewayBoundTool,
    authorization: GatewayToolAuthorization,
  ): Promise<GatewayExecutionResult> {
    try {
      const { call } = authorization;
      if ((await run.authorize(authorization)) !== null) return denied();
      if (run.scope.check(caller, this.#clock()) !== null) return denied();
      if (!tool.wireInputSchema.safeParse(call.input).success) {
        return rejected('invalid_request', 'Tool input does not satisfy the callable schema.');
      }
      if (
        tool.declaration.callMode === 'execute' &&
        tool.declaration.requiredCapabilities.includes('external') &&
        (run.admitExternal === undefined || (await run.admitExternal(authorization)) !== null)
      )
        return denied();
      if ((await run.authorize(authorization)) !== null) return denied();
      if (run.scope.check(caller, this.#clock()) !== null) return denied();
      // Closures own business parsing/transforms; passing parsed.data would apply them twice.
      const result = await tool.execute(structuredClone(call.input));
      const output = JSON.parse(
        encodeGatewayJson(result.output, this.#limits.maxOutputBytes, true),
      ) as JsonValue;
      const reply = freezeJson(
        ToolReplySchema.parse({
          protocolVersion: PROTOCOL_VERSION,
          runId: call.runId,
          callId: call.callId,
          ok: result.ok,
          output,
        }),
      );
      return { kind: 'reply', reply, replayed: false };
    } catch {
      return rejected(
        'runtime_failed',
        'Callable failed or returned an unsupported or oversized result.',
      );
    }
  }

  #wait(
    work: Promise<GatewayExecutionResult>,
    signal: AbortSignal,
  ): Promise<GatewayExecutionResult> {
    return new Promise((resolve) => {
      const finish = (result: GatewayExecutionResult) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve(result);
      };
      const abort = () =>
        finish(rejected('cancelled', 'Scope revoked; existing execution may still be active.'));
      const timer = setTimeout(
        () =>
          finish(
            rejected('timeout', 'Tool result is unconfirmed; do not repeat with a new callId.'),
          ),
        this.#limits.callTimeoutMs,
      );
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void work.then(finish);
    });
  }

  revoke(runId: string): void {
    this.#runs.get(runId)?.scope.revoke();
  }

  async drain(runId: string, timeoutMs = 1_000): Promise<GatewayDrainResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('Invalid drain timeout');
    const run = this.#runs.get(runId);
    if (run === undefined) return { drained: true, activeCalls: 0 };
    run.scope.revoke();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...run.inFlight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return { drained: run.inFlight.size === 0, activeCalls: run.inFlight.size };
  }

  receipts(runId: string): readonly ToolReply[] {
    return [...(this.#runs.get(runId)?.records.values() ?? [])].flatMap((record) =>
      record.reply === undefined ? [] : [record.reply],
    );
  }

  release(runId: string): boolean {
    const run = this.#runs.get(runId);
    if (run === undefined) return true;
    if (!run.scope.signal.aborted || run.inFlight.size > 0) return false;
    run.detachAbort();
    return this.#runs.delete(runId);
  }
}
