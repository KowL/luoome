import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCallableTool } from '@luoome/core';
import { createChatSessionTool } from '@luoome/tools';
import { buildTestContext, createTestPluginControl } from '@luoome/tools/testing';
import { type ChatStreamRuntime, createChatStreamResponse } from '../chat.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('fresh Agent manifests omit disabled strategy execution and restore it after opt-in', async () => {
  const home = mkdtempSync(join(tmpdir(), 'luoome-p3-agent-'));
  roots.push(home);
  const { executionPolicy, set: setPlugin } = createTestPluginControl(home);
  const ctx = await buildTestContext({ executionPolicy });
  const set = (enabled: boolean) => setPlugin('business.strategy-execution', enabled);
  let advertised: readonly AgentCallableTool[] = [];
  let calls = 0;
  const runtime: ChatStreamRuntime = {
    createUIMessageStreamResponse: async (request) => {
      advertised = request.tools;
      calls++;
      await request.onFinish?.({
        id: `assistant-${calls}`,
        cancelled: false,
        parts: [{ type: 'text', text: 'fixture' }],
      });
      return Response.json({ tools: request.tools.map((tool) => tool.name) });
    },
  };
  const chat = async () => {
    const created = await createChatSessionTool.execute({}, ctx);
    if (!created.ok) throw new Error('session fixture');
    const response = await createChatStreamResponse(
      {
        sessionId: created.data.session.id,
        messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '研究策略' }] }],
      },
      ctx,
      runtime,
    );
    expect(response.status).toBe(200);
    return advertised;
  };
  set(true);
  const tools = await chat();
  const old = tools.find((tool) => tool.name === 'run_strategy');
  if (!old) throw new Error('missing strategy callable');
  set(false);
  expect((await chat()).map((tool) => tool.name)).not.toContain('run_strategy');
  expect(await old.execute({ strategyId: 'fixture', mode: 'scheduled' })).toMatchObject({
    ok: false,
    output: { error: { kind: 'permission_denied' } },
  });
  set(true);
  expect((await chat()).map((tool) => tool.name)).toContain('run_strategy');
  await old.execute({ strategyId: 'fixture', mode: 'scheduled' });
});
