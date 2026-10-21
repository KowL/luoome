import { once } from 'node:events';
import { HostCommandSchema, type HostMessage } from '@luoome/dsh-bridge/protocol';
import { NodeRuntimeHost } from './host.js';

async function send(message: HostMessage): Promise<void> {
  if (!process.stdout.write(`${JSON.stringify(message)}\n`)) {
    await once(process.stdout, 'drain', { signal: AbortSignal.timeout(3000) });
  }
}

const config = process.env.LUOOME_DSH_HOST_CONFIG;
if (!config) throw new Error('LUOOME_DSH_HOST_CONFIG is required');
const host = new NodeRuntimeHost(JSON.parse(config), send);
delete process.env.LUOOME_DSH_HOST_CONFIG;
await send({
  type: 'ready',
  protocolVersion: 1,
  runtimeInstanceId: host.runtimeInstanceId,
  pid: process.pid,
  nodeVersion: process.version,
});
let shuttingDown: Promise<void> | undefined;
const shutdown = () => {
  shuttingDown ??= (async () => {
    let stopped = false;
    try {
      stopped = await host.close();
    } catch {
      stopped = false;
    }
    try {
      await send({ type: 'closed', stopped });
    } finally {
      process.exit(stopped ? 0 : 1);
    }
  })();
  return shuttingDown;
};
const report = (message: HostMessage) => send(message).catch(() => shutdown());
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});
process.stdout.on('error', () => {
  void shutdown();
});
process.stdin.once('end', () => {
  void shutdown();
});
process.stdin.setEncoding('utf8');
let pending = '';
process.stdin.on('data', (chunk: string) => {
  pending += chunk;
  if (Buffer.byteLength(pending) > 1_000_000) {
    void shutdown();
    return;
  }
  let newline = pending.indexOf('\n');
  while (newline >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    newline = pending.indexOf('\n');
    try {
      const command = HostCommandSchema.parse(JSON.parse(line));
      if (command.type === 'shutdown') {
        void shutdown();
        return;
      }
      if (command.type === 'cancel') {
        void host.cancel(command.request.runId, command.request.reason).catch(() =>
          report({
            type: 'error',
            runId: command.request.runId,
            error: { code: 'unresolved', message: 'Runtime stop is unresolved' },
          }),
        );
      } else {
        void host.run(command.request).catch(() =>
          report({
            type: 'error',
            runId: command.request.runId,
            error: { code: 'invalid_request', message: 'Host rejected this run' },
          }),
        );
      }
    } catch {
      void report({
        type: 'error',
        error: { code: 'invalid_request', message: 'Invalid Host command' },
      });
    }
  }
});
