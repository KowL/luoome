import { describe, expect, it } from 'bun:test';
import type { RunRequest } from '@luoome/dsh-bridge/protocol';
import { DshNodeHostClient } from './runtime-client.js';

const node = Bun.which('node');
if (node === null) throw new Error('Node is required for DSH process tests');
const hash = `sha256:${'a'.repeat(64)}`;
const request: RunRequest = {
  protocolVersion: 1,
  runId: 'r1',
  conversationId: 'c1',
  manifestHash: hash,
  manifest: { protocolVersion: 1, manifestHash: hash, tools: [] },
  configRef: 'fixture',
  instructions: '',
  prompt: 'fixture',
  expiresAt: '2099-01-01T00:00:00Z',
};
const script = (handleRun: string, shutdown = true) => `
import readline from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
send({type:'ready',protocolVersion:1,runtimeInstanceId:'fixture',pid:process.pid,nodeVersion:process.version});
readline.createInterface({input:process.stdin}).on('line',line=>{
  const value=JSON.parse(line);
  if(value.type==='run') { ${handleRun} }
  if(value.type==='shutdown') { ${shutdown ? "send({type:'closed',stopped:true}); process.exit(0);" : ''} }
});`;
const event = (conversationId: string) =>
  `send({type:'event',event:{protocolVersion:1,runId:'r1',conversationId:'${conversationId}',agentId:'main',source:'host',sourceEventId:'e1',sequence:0,timestamp:new Date().toISOString(),type:'run.terminal',payload:{status:'completed'}}});`;
const launch = (code: string) =>
  new DshNodeHostClient({
    executable: node,
    args: ['--input-type=module', '-e', code],
    cwd: process.cwd(),
    env: {},
    startupTimeoutMs: 1000,
    stopTimeoutMs: 100,
  });

describe('Node Host client (real Node, protocol fixture)', () => {
  it('runs only the bound conversation and confirms both drain receipt and process exit', async () => {
    const host = launch(script(event('c1')));
    const types: string[] = [];
    try {
      await host.run(request, (value) => types.push(value.type));
    } finally {
      expect(await host.close()).toBe(true);
    }
    expect(types).toEqual(['run.terminal']);
  });

  it('rejects a foreign conversation event and still closes the process', async () => {
    const host = launch(script(event('foreign')));
    await expect(host.run(request, () => {})).rejects.toThrow('protocol failed');
    expect(await host.close()).toBe(true);
  });

  it('does not call a killed Host proof of downstream drain', async () => {
    const host = launch(script(event('c1'), false));
    await host.run(request, () => {});
    expect(await host.close()).toBe(false);
  });

  it('rejects startup failure without exposing stderr', async () => {
    const host = launch("process.stderr.write('private-key'); process.exit(2)");
    await expect(host.run(request, () => {})).rejects.toThrow('exited');
    expect(await host.close()).toBe(false);
  });
});
