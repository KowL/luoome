import {
  loadConfiguredHostedProviders,
  openHostedService,
} from '../../web/src/hosted-composition.js';
import { assertHostedEnvironmentIsolation, loadHostedConfig } from '../../web/src/hosted-config.js';
import { writePrivateArtifact } from '../../web/src/hosted-runtime.js';
import { runHostedWorkerOnce } from '../../web/src/hosted-worker.js';

export const startHostedWorker = async () => {
  assertHostedEnvironmentIsolation();
  const config = loadHostedConfig();
  const service = openHostedService(config, await loadConfiguredHostedProviders(config));
  const workerId = `worker:${crypto.randomUUID()}`;
  const instance = process.env.HOSTED_WORKER_INSTANCE_ID ?? 'primary';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(instance)) {
    service.close();
    throw new Error('invalid worker instance identity');
  }
  const health = (stopped: boolean) =>
    writePrivateArtifact(
      service.root,
      `worker-health-${instance}.json`,
      JSON.stringify({ lastLoopAt: Date.now(), stopped }),
    );
  let stopped = false;
  const finished = (async () => {
    try {
      health(false);
      while (!stopped) {
        const result = await runHostedWorkerOnce(service, workerId);
        health(false);
        if (!result.processed) await Bun.sleep(1_000);
      }
    } finally {
      health(true);
      service.close();
    }
  })();
  return {
    finished,
    stop: () => {
      stopped = true;
    },
  };
};

if (import.meta.main) {
  const worker = await startHostedWorker();
  process.on('SIGINT', worker.stop);
  process.on('SIGTERM', worker.stop);
  await worker.finished;
}
