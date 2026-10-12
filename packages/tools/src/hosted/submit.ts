import { dateInShanghai, type HostedJob, type ToolResult } from '@luoome/core';
import { z } from 'zod';
import { errInvalidInput } from '../define-tool.js';
import {
  activateHostedJobTool,
  findHostedJobRequestTool,
  type PlatformContext,
  prepareHostedJobTool,
} from '../platform/index.js';
import { prepareWatchlistFactsRequestTool } from '../tools/hosted-tenant.js';
import {
  getTenantExecutionRequestTool,
  hashHostedInput,
  persistTenantExecutionRequestTool,
} from './execution.js';
import {
  authorizeHostedInvocation,
  contextForHostedTools,
  type HostedInvocation,
} from './invoke.js';

export const SubmitHostedJobInput = z
  .object({
    operation: z.literal('report.watchlist-facts'),
    version: z.literal(1),
    requestId: z.string().min(1).max(120),
    input: z
      .object({ watchlistId: z.string().min(1).max(160), period: z.string().date().optional() })
      .strict(),
  })
  .strict();

export const submitHostedJob = async (
  raw: unknown,
  invocation: HostedInvocation,
  platform: PlatformContext,
): Promise<ToolResult<{ job: HostedJob; replayed: boolean }>> => {
  const parsed = SubmitHostedJobInput.safeParse(raw);
  if (!parsed.success) return errInvalidInput('hosted job input is invalid');
  const input = parsed.data;
  const previous = await findHostedJobRequestTool.execute({ requestId: input.requestId }, platform);
  if (!previous.ok) return previous;
  const requestFingerprint = hashHostedInput(input);
  const tools = contextForHostedTools(
    invocation,
    new Set([
      getTenantExecutionRequestTool.name,
      prepareWatchlistFactsRequestTool.name,
      persistTenantExecutionRequestTool.name,
    ]),
    previous.data === null,
  );
  if (previous.data !== null) {
    if (previous.data.kind !== 'watchlist-facts')
      return errInvalidInput('request_id_input_conflict');
    const saved = await getTenantExecutionRequestTool.execute(
      { operationId: previous.data.operationId },
      tools,
    );
    if (!saved.ok) return saved;
    if (saved.data !== null) {
      if (
        saved.data.input._requestFingerprint !== requestFingerprint ||
        saved.data.inputHash !== previous.data.inputHash
      ) {
        return errInvalidInput('request_id_input_conflict');
      }
      if (previous.data.state !== 'preparing')
        return { ok: true, data: { job: previous.data, replayed: true } };
      const authorization = await authorizeHostedInvocation(
        invocation,
        ['write', 'external'],
        true,
      );
      if (authorization !== null) return authorization;
      const activated = await activateHostedJobTool.execute(
        { jobId: previous.data.id, inputHash: saved.data.inputHash },
        platform,
      );
      return activated.ok ? { ok: true, data: { job: activated.data, replayed: true } } : activated;
    }
  }
  const authorization = await authorizeHostedInvocation(invocation, ['write', 'external'], true);
  if (authorization !== null) return authorization;
  const snapshot = await prepareWatchlistFactsRequestTool.execute(
    {
      ...input.input,
      period: input.input.period ?? dateInShanghai(invocation.context.clock()),
      notificationPolicy: 'never',
    },
    tools,
  );
  if (!snapshot.ok) return snapshot;
  const privateInput = { ...snapshot.data.input, _requestFingerprint: requestFingerprint };
  const inputHash = hashHostedInput(privateInput);
  const prepared = await prepareHostedJobTool.execute(
    {
      kind: 'watchlist-facts',
      version: 1,
      requestId: input.requestId,
      payloadRef: previous.data?.payloadRef ?? `request:${input.requestId}`,
      inputHash,
    },
    platform,
  );
  if (!prepared.ok) return prepared;
  const persisted = await persistTenantExecutionRequestTool.execute(
    {
      operationId: prepared.data.job.operationId,
      inputHash,
      generation: invocation.identity.tenantGeneration,
      kind: 'watchlist-facts',
      input: privateInput,
      createdAt: prepared.data.job.createdAt,
    },
    tools,
  );
  if (!persisted.ok) return persisted;
  const activated = await activateHostedJobTool.execute(
    { jobId: prepared.data.job.id, inputHash },
    platform,
  );
  return activated.ok
    ? { ok: true, data: { job: activated.data, replayed: prepared.data.replayed } }
    : activated;
};
