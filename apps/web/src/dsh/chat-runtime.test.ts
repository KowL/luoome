import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SCENARIOS } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { DshChatRuntime } from './chat-runtime.js';

const runtime = () =>
  new DshChatRuntime({
    development: true,
    nodePath: '/fixture/node',
    hostEntry: '/fixture/host.js',
    cwd: '/fixture',
    model: {
      endpoint: 'https://fixture.invalid/chat/completions',
      model: 'fixture',
      maxTokens: 32,
      headers: {},
      fetch: (async () => {
        throw new Error('must not send');
      }) as unknown as typeof fetch,
    },
  });

it('refuses missing trusted scope, truncated histories and unmetered hosted configuration before spawning', async () => {
  const value = runtime();
  const request = { instructions: '', uiMessages: [], tools: [] };
  await expect(value.createUIMessageStreamResponse(request)).rejects.toThrow('trusted');
  const ctx = await buildTestContext();
  await expect(
    value.createUIMessageStreamResponse({
      ...request,
      execution: {
        context: ctx,
        runId: 'fixture-run',
        conversationId: 'fixture',
        scenario: AGENT_SCENARIOS.general,
        historyTruncated: true,
      },
    }),
  ).rejects.toThrow('截断');
  await expect(
    value.createUIMessageStreamResponse({
      ...request,
      execution: {
        runId: 'fixture-hosted-run',
        context: {
          ...ctx,
          identity: {
            mode: 'hosted',
            tenantId: 't1',
            tenantGeneration: 1,
            userId: ctx.user.id,
            actor: 'user',
            requestId: 'r1',
          },
        },
        conversationId: 'fixture',
        scenario: AGENT_SCENARIOS.general,
        historyTruncated: false,
      },
    }),
  ).rejects.toThrow('metered');
});

it('treats a pre-binding Host failure with a stopped receipt as drained, without leaking conversation capacity (Node protocol fixture)', async () => {
  const nodePath = Bun.which('node');
  if (nodePath === null) throw new Error('Node is required');
  const root = mkdtempSync(join(tmpdir(), 'dsh-startup-protocol-'));
  const entry = join(root, 'host.mjs');
  writeFileSync(
    entry,
    `import readline from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
send({type:'ready',protocolVersion:1,runtimeInstanceId:'fixture',pid:process.pid,nodeVersion:process.version});
readline.createInterface({input:process.stdin}).on('line', line=>{const value=JSON.parse(line);
if(value.type==='run')send({type:'event',event:{protocolVersion:1,runId:value.request.runId,conversationId:value.request.conversationId,agentId:'not-created',source:'host',sourceEventId:'startup',sequence:0,timestamp:new Date().toISOString(),type:'run.terminal',payload:{status:'failed',runtimeStopped:true}}});
if(value.type==='shutdown'){send({type:'closed',stopped:true});process.exit(0);}});`,
  );
  const ctx = await buildTestContext();
  const value = new DshChatRuntime({
    development: true,
    nodePath,
    hostEntry: entry,
    cwd: root,
    model: {
      endpoint: 'https://fixture.invalid/chat/completions',
      model: 'fixture',
      maxTokens: 32,
      headers: {},
      fetch: (async () => {
        throw new Error('must not send');
      }) as unknown as typeof fetch,
    },
  });
  try {
    for (let index = 0; index < 2; index++) {
      let stopped = false;
      const response = await value.createUIMessageStreamResponse({
        instructions: '',
        uiMessages: [],
        tools: [],
        execution: {
          context: ctx,
          runId: `startup-${index}`,
          conversationId: 'known-startup-failure',
          scenario: AGENT_SCENARIOS.general,
          historyTruncated: false,
        },
        onFinish: (message) => {
          stopped = message.executionStopped === true;
        },
      });
      const body = await response.text();
      expect(body).toContain('"status":"failed"');
      expect(body).not.toContain('"status":"unresolved"');
      expect(stopped).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
