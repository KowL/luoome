import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import {
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
  type StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { type ScheduleRecord, ScheduleService } from '@deepseek-ai/dsh-schedule';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { Storage } from '@deepseek-ai/dsh-storage';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { type ApprovalOutcome, ApprovalService } from '@deepseek-ai/dsh-user-approval';
import type { PluginAutomationGrant, RepositoryRegistry, ToolContext } from '@luoome/core';
import { seedData } from '@luoome/db/memory';
import {
  type ConfirmablePluginTool,
  decisionReviewOperation,
  defineTool,
  pluginInputHash,
  pluginInputJson,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { z } from 'zod';
import { createDshOperationHost } from '../host/dsh-authority.js';
import { dshScheduleHash } from '../host/dsh-identity.js';

export type Call = { name: string; input: unknown };
class ScriptedModel extends LlmAdapter {
  readonly calls: Call[][] = [];
  requests = 0;
  async *stream(): AsyncIterable<StreamChunk> {
    this.requests++;
    const calls = this.calls.shift() ?? [];
    for (const [index, call] of calls.entries()) {
      const id = ToolCallId(randomUUID());
      const args = JSON.stringify(call.input);
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args };
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id, name: call.name, arguments: args },
      };
    }
    if (calls.length === 0) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'done' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } };
    }
    yield { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } };
  }
}

export const scheduledOperationFixture = () => {
  const batch = defineTool({
    name: 'fixture_scheduled_write',
    description: 'temporary integration write',
    sideEffect: 'write',
    requiredCapabilities: ['write', 'external'],
    input: z.object({ accountId: z.string(), label: z.string().min(1) }).strict(),
    output: z.object({ saved: z.boolean() }),
    handler: async (input, toolContext) => {
      const account = await toolContext.repos.account.findById(input.accountId);
      if (!account) throw new Error('Missing synthetic account');
      await toolContext.repos.account.save({ ...account, name: `${account.name}|${input.label}` });
      return { saved: true };
    },
  });
  const policy: ConfirmablePluginTool = {
    tool: batch,
    scheduled: true,
    bind(raw, owner) {
      const input = batch.inputSchema.parse(raw);
      if (input.accountId !== owner.accountId) throw new Error('Wrong account');
      return input;
    },
    receipt: async () => null,
  };
  return { batch, policy };
};

export const createDshTestHost = async (
  root: string,
  db: { repos: RepositoryRegistry; close(): void },
  options: {
    automationsEnabled?: boolean;
    policy?: 'ask' | 'never';
    resume?: boolean;
    withoutApproval?: boolean;
    bypassPre?: boolean;
    noAnswerer?: boolean;
    ptc?: boolean;
  } = {},
) => {
  const ctx = new Context();
  const fibers: Array<{ dispose(): Promise<void> }> = [];
  const mount = async (plugin: Parameters<Context['plugin']>[0], config?: unknown) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.await();
  };
  await mount(AgentRegistry);
  await mount(SessionStore);
  await mount(SessionProjectionRegistry);
  await mount(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
  if (options.ptc) {
    const [
      { NodePtcRuntime },
      { LocalFileSystem },
      { LocalSubprocessRuntime },
      { LocalSandboxProvider },
      { SandboxPolicyService },
      { WorkingDirectoryService },
    ] = await Promise.all([
      import('@deepseek-ai/dsh-ptc-runtime-node'),
      import('@deepseek-ai/dsh-fs-local'),
      import('@deepseek-ai/dsh-subprocess-local'),
      import('@deepseek-ai/dsh-sandbox-local'),
      import('@deepseek-ai/dsh-sandbox-policy'),
      import('@deepseek-ai/dsh-working-directory'),
    ]);
    const node = process.execPath;
    await mount(LocalFileSystem, { cwd: root });
    await mount(LocalSubprocessRuntime);
    await mount(LocalSandboxProvider, {});
    await mount(SandboxPolicyService, { mode: 'read-only', workspaceRoot: root });
    await mount(WorkingDirectoryService, { defaultDirectory: root });
    await mount(NodePtcRuntime, {
      launch: { kind: 'node-script', executable: node },
      timeoutMs: 10_000,
      maxTimeoutMs: 20_000,
    });
  }
  await mount(ToolRuntime, { mode: options.ptc ? 'ptc' : 'native' });
  await mount(LlmRuntime);
  const model = new ScriptedModel();
  ctx.llm.registerAdapter(['fixture'], model);
  await mount(Storage);
  await mount(JsonStorage, { root: join(root, 'storage') });
  await mount(Domain, { backend: 'json' });
  await mount(Persistence, { root: join(root, 'sessions'), compression: 'none' });
  await mount(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
  if (!options.withoutApproval) await mount(ApprovalService, { policy: options.policy ?? 'ask' });
  const sessionId = SessionId('luoome-integration');
  const agentOptions = { provider: 'fixture', model: 'scripted' };
  const handle = options.resume
    ? await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
    : await ctx.agents.create({ sessionId, agentOptions });
  // The Web controller's unrelated UI/model-selection surface is outside this fixture.
  // Schedule receives the real live Agent; all delivery, inbox and persistence services are real.
  ctx.provide('sessionController', {
    resolveAgent: async (id: string) => {
      const agent = ctx.agents.get(SessionId(id));
      if (!agent) throw new Error('No live fixture session');
      return { agent };
    },
  });
  await mount(ScheduleService, {});
  const fixture = await buildTestContext();
  if ((await db.repos.account.list()).length === 0)
    await seedData(db.repos, {
      accounts: await fixture.repos.account.list(),
      advices: await fixture.repos.advice.query({ includeExpired: true }),
    });
  const domain: ToolContext = { ...fixture, repos: db.repos };
  const principal = { userId: 'local-fixture', accountId: domain.user.defaultAccountId };
  const { batch, policy } = scheduledOperationFixture();
  if (options.bypassPre) ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }));
  const host = createDshOperationHost(ctx, {
    repository: db.repos.pluginAuthority,
    policies: [decisionReviewOperation, policy],
    capabilities: ['write', 'external'],
    policyVersion: 1,
    now: () => Date.now(),
    context: () => domain,
    profile: 'validation',
    principalForSession: () => principal,
    automationsEnabled: options.automationsEnabled ?? false,
  });
  const results: Array<{ name: string; value: unknown; isError: boolean; diagnostic: string }> = [];
  const approvals: ApprovalOutcome[] = [];
  ctx.on('tools/result', (exec, result) => {
    results.push({
      name: exec.name,
      value: 'value' in result ? result.value : null,
      isError: result.isError,
      diagnostic: result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    });
  });
  const answer = (outcome: ApprovalOutcome) =>
    ctx.on('approval/request', async () => {
      approvals.push(outcome);
      return outcome;
    });
  const run = async (call: Call, text = 'authorized fixture request') => {
    const presented = options.ptc
      ? {
          name: 'run_code',
          input: {
            code: `return await tools.${call.name}(${JSON.stringify(call.input)});`,
            description: text,
          },
        }
      : call;
    model.calls.push([presented], []);
    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    );
    await handle.agent.whenIdle();
    await ctx.sessions.flush(handle.agent.session);
    return results.at(-1);
  };
  const grant = (task: ScheduleRecord, input: unknown, id = 'grant'): PluginAutomationGrant => ({
    id,
    identity: { userId: principal.userId, profile: 'validation', sessionId, taskId: task.id },
    scheduleHash: dshScheduleHash(task),
    version: 1,
    policyVersion: 1,
    enabled: true,
    allowedCalls: [
      {
        tool: batch.name,
        accountId: principal.accountId,
        inputJson: pluginInputJson(input),
        inputHash: pluginInputHash(input),
        capabilities: ['write', 'external'],
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  });
  const close = async () => {
    host.dispose();
    await handle.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await ctx.fiber.dispose();
    db.close();
  };
  return {
    ctx,
    handle,
    host,
    domain,
    db,
    principal,
    model,
    results,
    approvals,
    answer,
    run,
    grant,
    close,
    batch,
  };
};
