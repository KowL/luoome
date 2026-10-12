import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { FixtureEmailOtpAdapter } from '@luoome/adapters/hosted';
import { stockCode, type ToolResult } from '@luoome/core';
import { createAuthSessionTool, requestAuthChallengeTool } from '@luoome/tools/platform';
import { createHostedBackup } from '../../web/src/hosted-backup.js';
import { hostedFixturePlan, openHostedService } from '../../web/src/hosted-composition.js';
import { assertHostedEnvironmentIsolation, loadHostedConfig } from '../../web/src/hosted-config.js';
import {
  prepareHostedRestore,
  resumeHostedRestoredService,
} from '../../web/src/hosted-recovery.js';
import { writePrivateArtifact } from '../../web/src/hosted-runtime.js';
import { createHostedWebApp } from '../../web/src/hosted-server.js';
import { runHostedWorkerOnce } from '../../web/src/hosted-worker.js';

const value = <T>(result: ToolResult<T>): T => {
  if (!result.ok) throw new Error(`fixture_tool_failed:${result.error.kind}`);
  return result.data;
};

export const runHostedFixtureLoad = async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'luoome-fixture-load-'));
  const origin = 'https://load-fixture.example.invalid';
  const clock = () => new Date('2026-10-12T02:00:00Z');
  const config = loadHostedConfig({
    LUOOME_MODE: 'hosted',
    HOSTED_ENVIRONMENT: 'development',
    HOSTED_DATA_ROOT: join(temporary, 'data'),
    PUBLIC_ORIGIN: origin,
    HOSTED_AUTH_SECRET: 'fixture-load-only-secret-at-least-32-characters',
    HOSTED_PRODUCT_POLICY: 'hosted-facts-v1',
    HOSTED_PROVIDER_MODE: 'fixture',
    HOSTED_RUNTIME_LIMIT: '32',
    HOSTED_REGISTRATION_LIMIT: '100',
    HOSTED_REGISTRATION_ENABLED: 'true',
    LUOOME_EXPOSE_WRITE: 'true',
    LUOOME_EXPOSE_EXTERNAL: 'true',
  });
  const initial = openHostedService(config, undefined, clock);
  const providers = {
    ...initial.providers,
    trialPlan: hostedFixturePlan,
    stockSeed: Array.from({ length: 50 }, (_, i) => ({
      id: `${600000 + i}.SH`,
      code: stockCode(String(600000 + i)),
      exchange: 'SH' as const,
      name: `压测模拟股票 ${i + 1}`,
    })),
  };
  initial.close();
  const service = openHostedService(config, providers, clock);
  const app = createHostedWebApp({
    config,
    repos: service.repos,
    runtimes: service.runtimes,
    maintenance: service.maintenance,
    market: providers.market,
    emailOtp: providers.emailOtp,
    notification: providers.notification,
    payment: providers.payment,
    jobPolicies: providers.jobPolicies,
    clock,
  });
  const actors: Array<{ cookie: string; csrf: string; tenantId: string; watchlistId: string }> = [];
  const request = async (actor: (typeof actors)[number], path: string, input?: unknown) => {
    const response = await app.fetch(
      new Request(`${origin}${path}`, {
        method: input === undefined ? 'GET' : 'POST',
        headers: {
          origin,
          cookie: actor.cookie,
          'x-csrf-token': actor.csrf,
          'content-type': 'application/json',
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
    );
    if (!response.ok) throw new Error(`fixture_http_failed:${response.status}`);
    return value((await response.json()) as ToolResult<Record<string, unknown>>);
  };
  const started = performance.now();
  try {
    if (!(providers.emailOtp instanceof FixtureEmailOtpAdapter))
      throw new Error('fixture_email_required');
    for (let i = 0; i < 100; i++) {
      const context = service.platformContext({
        kind: 'anonymous',
        requestId: crypto.randomUUID(),
        ipKey: createHash('sha256').update(`load-fixture-${i}`).digest('hex'),
      });
      const challenge = value(
        await requestAuthChallengeTool.execute({ email: `load-${i}@example.invalid` }, context),
      );
      const code = providers.emailOtp.getMessage(challenge.challengeId)?.code;
      if (code === undefined) throw new Error('fixture_otp_missing');
      const session = value(
        await createAuthSessionTool.execute({ challengeId: challenge.challengeId, code }, context),
      );
      actors.push({
        cookie: `__Host-luoome_session=${session.sessionToken}`,
        csrf: session.csrfToken,
        tenantId: session.tenant.id,
        watchlistId: '',
      });
    }
    for (let i = 0; i < 100; i++) await runHostedWorkerOnce(service, 'fixture-load-worker');
    for (const actor of actors) {
      const created = await request(actor, '/api/watchlists', { name: '压测自选' });
      actor.watchlistId = (created.watchlist as { id: string }).id;
      const preview = (
        await request(actor, `/api/watchlists/${actor.watchlistId}/import/preview`, {
          content: providers.stockSeed.map((stock) => stock.id).join('\n'),
          format: 'text',
        })
      ).preview as { id: string; inputHash: string; rows: Array<{ row: number; stockId: string }> };
      await request(actor, '/api/watchlists/import/commit', {
        previewId: preview.id,
        inputHash: preview.inputHash,
        requestId: 'fixture-import',
        selections: preview.rows.map(({ row, stockId }) => ({ row, stockId })),
        excludedRows: [],
        acknowledgeExtraColumns: false,
      });
      await request(actor, '/api/alerts', {
        plan: {
          id: 'fixture-load-plan',
          name: '压测条件',
          watchlistId: actor.watchlistId,
          rules: Array.from({ length: 10 }, (_, i) => ({
            id: `rule-${i}`,
            kind: 'price-level',
            level: 1000000 + i,
            side: 'above',
          })),
          logic: 'ANY',
          triggerMode: 'on-enter',
          cooldownMinutes: 60,
          dailyNotificationLimit: 20,
          notifyOnRecovery: false,
          enabled: true,
        },
        expectedPlanRevision: null,
        requestId: 'fixture-plan',
        enableConfirmed: true,
      });
      await request(actor, '/api/jobs', {
        operation: 'report.watchlist-facts',
        version: 1,
        requestId: 'fixture-facts',
        input: { watchlistId: actor.watchlistId },
      });
    }
    const setupMs = performance.now() - started;
    const workerStarted = performance.now();
    for (let i = 0; i < 201; i++) await runHostedWorkerOnce(service, 'fixture-load-worker');
    const workerMs = performance.now() - workerStarted;
    const latencies: number[] = [];
    let peakOpen = 0;
    for (let batch = 0; batch < 10; batch++)
      await Promise.all(
        Array.from({ length: 30 }, async (_, i) => {
          const actor = actors[(batch * 30 + i) % actors.length];
          if (actor === undefined) throw new Error('fixture_actor_missing');
          const at = performance.now();
          await request(actor, `/api/watchlists/${actor.watchlistId}`);
          latencies.push(performance.now() - at);
          peakOpen = Math.max(peakOpen, service.runtimes.status.open);
        }),
      );
    latencies.sort((a, b) => a - b);
    const jobs = (
      await Promise.all(
        actors.map((actor) => service.repos.jobs.list({ tenantId: actor.tenantId })),
      )
    ).flat();
    if (jobs.some((job) => !['succeeded', 'partial'].includes(job.state)))
      throw new Error('fixture_jobs_not_settled');
    const heldUnits = (
      await Promise.all(
        actors.map((actor) =>
          service.repos.subscriptions.currentEntitlement({
            tenantId: actor.tenantId,
            now: clock(),
          }),
        ),
      )
    ).reduce((sum, entitlement) => sum + (entitlement?.heldUnits ?? 0), 0);
    if (heldUnits !== 0) throw new Error('fixture_reservations_not_settled');
    const backupAt = performance.now();
    const manifest = await createHostedBackup({
      dataRoot: service.root,
      destination: join(temporary, 'backup'),
      gate: service.maintenance,
    });
    const backupMs = performance.now() - backupAt;
    service.close();
    const restoreAt = performance.now();
    const restore = await prepareHostedRestore({
      source: join(temporary, 'backup'),
      destination: join(temporary, 'restored'),
      deletionLedger: config.deletionLedgerRoot,
      config,
      writersStopped: true,
      clock,
    });
    await resumeHostedRestoredService({
      dataRoot: join(temporary, 'restored'),
      writersStopped: true,
    });
    return {
      version: 1,
      fixture: true,
      productionCapacityVerified: false,
      measuredAt: new Date().toISOString(),
      machine: {
        platform: process.platform,
        arch: process.arch,
        cpuCount: cpus().length,
        memoryGiB: totalmem() / 1024 ** 3,
        bun: Bun.version,
      },
      model: {
        tenants: 100,
        stocksPerTenant: 50,
        enabledRulesPerTenant: 10,
        concurrentReads: 30,
        workerInstances: 1,
        runtimeLimit: 32,
        providerMode: 'fixture',
      },
      setupMs,
      workerMs,
      jobs: jobs.length,
      succeeded: jobs.filter((job) => job.state === 'succeeded').length,
      partial: jobs.filter((job) => job.state === 'partial').length,
      reads: latencies.length,
      readP50Ms: latencies[Math.floor(latencies.length * 0.5)],
      readP95Ms: latencies[Math.floor(latencies.length * 0.95)],
      readMaxMs: latencies.at(-1),
      peakOpen,
      heldUnits,
      rssMiB: process.memoryUsage().rss / 1024 ** 2,
      backupMs,
      backupBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
      restoreMs: performance.now() - restoreAt,
      pendingReview: restore.pendingReview,
      unresolvedResults: restore.unresolvedResults,
    };
  } finally {
    service.close();
    rmSync(temporary, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  assertHostedEnvironmentIsolation();
  if (process.argv[2] !== '--fixture' || process.argv[3] === undefined || process.argv.length !== 4)
    throw new Error('usage: fixture-load --fixture OUTPUT_JSON');
  const output = resolve(process.argv[3]);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const result = await runHostedFixtureLoad();
  writePrivateArtifact(
    dirname(output),
    output.split('/').at(-1) as string,
    JSON.stringify(result, null, 2),
  );
  console.info(JSON.stringify(result));
}
