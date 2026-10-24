import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  canClaimPluginOperation,
  type PluginAuthorityRepository,
  PluginAutomationGrantSchema,
  type PluginOperation,
  type PluginOperationProof,
  type PluginTaskIdentity,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, type Tool } from './define-tool.js';

export interface PluginPrincipal {
  readonly userId: string;
  readonly accountId: string;
}
export interface ConfirmablePluginTool {
  readonly tool: Tool;
  readonly scheduled: boolean;
  bind(input: unknown, principal: PluginPrincipal, operationId: string): unknown;
  receipt(input: unknown, ctx: ToolContext): Promise<ToolResult<unknown> | null>;
}

export const pluginInputJson = (input: unknown): string => {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sort(v)]),
      );
    return value;
  };
  return JSON.stringify(sort(JSON.parse(JSON.stringify(input))));
};
export const pluginInputHash = (input: unknown): string =>
  createHash('sha256').update(pluginInputJson(input)).digest('hex');
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const denied = (): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required: 'current operation authority' },
});
const invalid = (): ToolResult<never> => ({
  ok: false,
  error: { kind: 'invalid_input', message: 'Invalid or conflicting operation', issues: [] },
});
const hasForce = (input: unknown): boolean =>
  input !== null &&
  typeof input === 'object' &&
  Object.entries(input).some(
    ([key, value]) => (key === 'force' && value === true) || hasForce(value),
  );
const publicOperation = (op: PluginOperation) => ({
  operationId: op.id,
  accountId: op.accountId,
  tool: op.tool,
  state: op.state,
  input: JSON.parse(op.inputJson) as unknown,
  expiresAt: op.expiresAt,
  result: op.resultJson === null ? null : (JSON.parse(op.resultJson) as unknown),
});

export const createPluginOperationService = (options: {
  readonly repository: PluginAuthorityRepository;
  readonly policies: readonly ConfirmablePluginTool[];
  readonly capabilities: readonly ('read' | 'write' | 'external')[];
  readonly policyVersion: number;
  readonly now: () => number;
  readonly context: () => ToolContext | Promise<ToolContext>;
  readonly validateGrant?: (
    grant: import('@luoome/core').PluginAutomationGrant,
  ) => Promise<boolean>;
}) => {
  if (process.env.LUOOME_EXPOSE_TRADE === 'true')
    throw new Error('LUOOME_EXPOSE_TRADE=true is not allowed');
  z.number().int().positive().parse(options.policyVersion);
  const capabilities = new Set(options.capabilities);
  const policies = new Map<string, ConfirmablePluginTool>();
  for (const policy of options.policies) {
    if (policies.has(policy.tool.name)) throw new Error('Duplicate operation policy');
    if (
      policy.tool.requiredCapabilities.some((c) => c === 'trade' || c === 'queue') ||
      policy.tool.sideEffect === 'trade'
    )
      throw new Error('Unsupported operation capability');
    policies.set(policy.tool.name, policy);
  }
  const repo = options.repository;
  let disposed = false;
  const allowed = (policy: ConfirmablePluginTool) =>
    !disposed &&
    policy.tool.requiredCapabilities.every((c) =>
      capabilities.has(c as 'read' | 'write' | 'external'),
    );

  const grantInput = z
    .object({
      grant: PluginAutomationGrantSchema,
      expectedVersion: z.number().int().positive().nullable(),
    })
    .strict();
  const grantTool = defineTool({
    name: 'configure_plugin_automation',
    description: 'Confirm an exact task authorization',
    sideEffect: 'write',
    input: grantInput,
    output: z.object({ grantId: z.string(), version: z.number() }),
    handler: async ({ grant, expectedVersion }) => {
      if (
        grant.enabled &&
        (grant.expiresAt <= options.now() ||
          !options.validateGrant ||
          !(await options.validateGrant(grant)))
      )
        return denied();
      if (!(await repo.saveGrant(grant, expectedVersion))) return invalid();
      return { grantId: grant.id, version: grant.version };
    },
  });
  if (policies.has(grantTool.name)) throw new Error('Reserved operation policy');
  policies.set(grantTool.name, {
    tool: grantTool,
    scheduled: false,
    bind(raw, principal) {
      const input = grantInput.parse(raw);
      if (
        input.grant.identity.userId !== principal.userId ||
        input.grant.policyVersion !== options.policyVersion ||
        input.grant.allowedCalls.some((call) => {
          if (!input.grant.enabled) return call.accountId !== principal.accountId;
          const policy = policies.get(call.tool);
          if (
            call.accountId !== principal.accountId ||
            !policy?.scheduled ||
            !allowed(policy) ||
            policy.tool.requiredCapabilities.some(
              (c) => !call.capabilities.includes(c as 'read' | 'write' | 'external'),
            )
          )
            return true;
          const bound = policy.bind(JSON.parse(call.inputJson), principal, 'grant-preview');
          return (
            hasForce(bound) ||
            !policy.tool.inputSchema.safeParse(bound).success ||
            pluginInputJson(bound) !== call.inputJson ||
            pluginInputHash(bound) !== call.inputHash
          );
        })
      )
        throw new Error('Grant scope mismatch');
      return input;
    },
    async receipt(raw) {
      const { grant } = grantInput.parse(raw);
      const stored = await repo.findGrant(grant.id, grant.identity.userId);
      return stored && pluginInputJson(stored) === pluginInputJson(grant)
        ? { ok: true, data: { grantId: grant.id, version: grant.version } }
        : null;
    },
  });

  const makeOperation = (
    principal: PluginPrincipal,
    id: string,
    policy: ConfirmablePluginTool,
    raw: unknown,
    authorization: PluginOperation['authorization'],
  ): PluginOperation => {
    const input = policy.bind(raw, principal, id);
    // Freeze wire input; preserve the original tool's validation/default/transform pipeline.
    const inputJson = pluginInputJson(input);
    policy.tool.inputSchema.parse(JSON.parse(inputJson));
    const now = options.now();
    return {
      id,
      ...principal,
      tool: policy.tool.name,
      inputJson,
      inputHash: pluginInputHash(JSON.parse(inputJson)),
      policyVersion: options.policyVersion,
      requiredCapabilities: policy.tool
        .requiredCapabilities as PluginOperation['requiredCapabilities'],
      authorization,
      state: 'pending',
      claimToken: null,
      resultJson: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 600_000,
    };
  };
  const identical = (a: PluginOperation, b: PluginOperation) =>
    a.tool === b.tool &&
    a.inputHash === b.inputHash &&
    a.policyVersion === b.policyVersion &&
    a.authorization.kind === b.authorization.kind &&
    (a.authorization.kind !== 'schedule' ||
      (b.authorization.kind === 'schedule' &&
        a.authorization.grantId === b.authorization.grantId &&
        a.authorization.grantVersion === b.authorization.grantVersion));

  const execute = async (
    operation: PluginOperation,
    proof: PluginOperationProof,
    signal: AbortSignal,
  ): Promise<ToolResult<unknown>> => {
    const policy = policies.get(operation.tool);
    if (
      !policy ||
      !allowed(policy) ||
      signal.aborted ||
      operation.policyVersion !== options.policyVersion
    )
      return denied();
    if (operation.state !== 'pending') return { ok: true, data: publicOperation(operation) };
    const ctx = await options.context();
    if (!allowed(policy) || signal.aborted) return denied();
    const claimToken = randomUUID();
    const claimed = await repo.claimOperation({
      ...proof,
      now: options.now(),
      claimToken,
    });
    if (!claimed) {
      const current = await repo.findOperation(proof);
      return current && current.state !== 'pending'
        ? { ok: true, data: publicOperation(current) }
        : denied();
    }
    let result: ToolResult<unknown> | null = null;
    try {
      if (!signal.aborted && !disposed)
        result = await policy.tool.execute(JSON.parse(claimed.inputJson), ctx);
    } catch {
      // A thrown/failed business call may already have committed; never blindly replay it.
    }
    const state = result?.ok ? 'succeeded' : 'unknown';
    await repo.settleOperation({
      ...proof,
      claimToken,
      state,
      resultJson: result === null ? null : JSON.stringify(result),
      now: options.now(),
    });
    const saved = await repo.findOperation(proof);
    return saved ? { ok: true, data: publicOperation(saved) } : denied();
  };
  const safe = async (fn: () => Promise<ToolResult<unknown>>): Promise<ToolResult<unknown>> => {
    if (disposed) return denied();
    try {
      return await fn();
    } catch {
      return {
        ok: false,
        error: {
          kind: 'internal',
          cause: 'Operation unavailable; query its status before retrying',
        },
      };
    }
  };
  return {
    prepare(principal: PluginPrincipal, request: { id: string; tool: string; input: unknown }) {
      return safe(async () => {
        const policy = policies.get(request.tool);
        if (!policy || !allowed(policy)) return denied();
        if (!z.uuid().safeParse(request.id).success) return invalid();
        const token = randomBytes(32).toString('base64url');
        let op: PluginOperation;
        try {
          op = makeOperation(principal, request.id, policy, request.input, {
            kind: 'human',
            tokenHash: tokenHash(token),
          });
        } catch {
          return invalid();
        }
        if (!(await repo.insertOperation(op))) {
          const existing = await repo.findOperation({ ...principal, id: request.id });
          return existing && identical(existing, op)
            ? { ok: true, data: publicOperation(existing) }
            : invalid();
        }
        return { ok: true, data: { ...publicOperation(op), confirmationToken: token } };
      });
    },
    confirm(
      principal: PluginPrincipal,
      request: { id: string; token: string },
      signal: AbortSignal,
    ) {
      return safe(async () => {
        const op = await repo.findOperation({ ...principal, id: request.id });
        if (
          op?.authorization.kind !== 'human' ||
          op.authorization.tokenHash !== tokenHash(request.token)
        )
          return denied();
        return execute(
          op,
          {
            ...principal,
            id: op.id,
            now: options.now(),
            policyVersion: options.policyVersion,
            authorization: { kind: 'human', tokenHash: tokenHash(request.token) },
          },
          signal,
        );
      });
    },
    cancel(principal: PluginPrincipal, request: { id: string; token: string }) {
      return safe(async () =>
        (await repo.cancelOperation({
          ...principal,
          id: request.id,
          now: options.now(),
          policyVersion: options.policyVersion,
          authorization: { kind: 'human', tokenHash: tokenHash(request.token) },
        }))
          ? { ok: true, data: { state: 'cancelled' } }
          : denied(),
      );
    },
    get(principal: PluginPrincipal, id: string) {
      return safe(async () => {
        const op = await repo.findOperation({ ...principal, id });
        return op ? { ok: true, data: publicOperation(op) } : denied();
      });
    },
    reconcile(principal: PluginPrincipal, id: string) {
      return safe(async () => {
        const op = await repo.findOperation({ ...principal, id });
        const policy = op && policies.get(op.tool);
        if (!op || !policy || !allowed(policy)) return denied();
        if (op.state === 'executing' || op.state === 'unknown') {
          const receipt = await policy.receipt(JSON.parse(op.inputJson), await options.context());
          await repo.settleOperation({
            ...principal,
            id,
            claimToken: op.claimToken,
            state: receipt?.ok ? 'succeeded' : 'unknown',
            resultJson: receipt?.ok ? JSON.stringify(receipt) : op.resultJson,
            now: options.now(),
          });
        }
        const saved = await repo.findOperation({ ...principal, id });
        return saved ? { ok: true, data: publicOperation(saved) } : denied();
      });
    },
    executeScheduled(
      identity: PluginTaskIdentity,
      request: {
        grantId: string;
        grantVersion: number;
        occurrenceId: string;
        tool: string;
        accountId: string;
        input: unknown;
      },
      signal: AbortSignal,
    ) {
      return safe(async () => {
        const policy = policies.get(request.tool);
        if (
          !policy?.scheduled ||
          !allowed(policy) ||
          !request.occurrenceId ||
          hasForce(request.input)
        )
          return denied();
        const principal = { userId: identity.userId, accountId: request.accountId };
        const id = `schedule:${pluginInputHash({ identity, occurrenceId: request.occurrenceId, tool: request.tool, accountId: request.accountId })}`;
        let op: PluginOperation;
        try {
          op = makeOperation(principal, id, policy, request.input, {
            kind: 'schedule',
            grantId: request.grantId,
            grantVersion: request.grantVersion,
          });
        } catch {
          return invalid();
        }
        // Validate current authority before creating even a pending record; claim repeats this atomically.
        const grant = await repo.findGrant(request.grantId, identity.userId);
        const proof: PluginOperationProof = {
          ...principal,
          id,
          now: options.now(),
          policyVersion: options.policyVersion,
          authorization: { kind: 'schedule', identity },
        };
        if (!canClaimPluginOperation(op, proof, grant)) return denied();
        if (!(await repo.insertOperation(op))) {
          const existing = await repo.findOperation({ ...principal, id });
          if (!existing || !identical(existing, op)) return invalid();
          op = existing;
        }
        return execute(op, proof, signal);
      });
    },
    dispose() {
      disposed = true;
    },
  };
};
