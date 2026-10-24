import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCliContext } from '../../packages/cli/src/context.js';
import { createDefaultAccount, money, StockSchema } from '../../packages/core/src/index.js';
import { createDrizzleRepos } from '../../packages/db/src/index.js';
import { enqueueAnalysisJobTool } from '../../packages/tools/src/index.js';

const home = resolve(process.env.LUOOME_HOME ?? '');
if (!home.startsWith('/tmp/luoome-queue-e2e-'))
  throw new Error('E2E requires an isolated /tmp directory');
const mode = process.argv[2];
await mkdir(home, { recursive: true });
const store = createDrizzleRepos(join(home, 'luoome.db'));
if (mode === 'seed') {
  if ((await store.repos.account.list()).length) throw new Error('Fixture database must be empty');
  const now = new Date();
  await store.repos.account.save(createDefaultAccount(now));
  await store.repos.stock.save(
    StockSchema.parse({
      id: '600519.SH',
      code: '600519',
      exchange: 'SH',
      name: '隔离验收标的（合成数据）',
    }),
  );
  await store.repos.quote.save({
    stockId: '600519.SH',
    ts: now,
    observedAt: now,
    fetchedAt: now,
    timestampSource: 'upstream',
    open: money(100),
    high: money(101),
    low: money(99),
    close: money(100),
    volume: 1000,
    source: 'isolated-e2e-fixture',
  });
  store.close();
  const handle = await createCliContext();
  try {
    const result = await enqueueAnalysisJobTool.execute(
      { kind: 'advice_stock', subject: { kind: 'stock', id: '600519.SH' }, source: 'schedule' },
      handle.ctx,
    );
    if (!result.ok) throw new Error(result.error.kind);
    console.log(JSON.stringify({ seeded: true, jobId: result.data.jobId }));
  } finally {
    handle.close();
  }
} else if (mode === 'faults') {
  store.close();
  const handle = await createCliContext();
  try {
    const enqueued = await enqueueAnalysisJobTool.execute(
      { kind: 'advice_stock', subject: { kind: 'stock', id: '600519.SH' }, source: 'schedule' },
      handle.ctx,
    );
    if (!enqueued.ok || enqueued.data.deduped) throw new Error('Expected a new isolated job');
  } finally {
    handle.close();
  }
  const invoke = (name: string, input: unknown) => {
    const run = Bun.spawnSync(
      [
        'bun',
        '--no-env-file',
        'packages/cli/src/index.ts',
        'tools',
        'call',
        name,
        '--input',
        JSON.stringify(input),
        '--json',
      ],
      { cwd: process.cwd(), env: { ...process.env, LUOOME_EXPOSE_QUEUE: 'true' } },
    );
    const result = JSON.parse(new TextDecoder().decode(run.stdout));
    if (run.exitCode !== 0 || !result.ok) throw new Error(`Tool failed: ${name}`);
    return result.data;
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { claims } = invoke('claim_analysis_jobs', { owner: 'e2e-fault', limit: 1 });
    if (claims.length !== 1 || claims[0].job.attempts !== attempt)
      throw new Error('Unexpected claim attempt');
    invoke('fail_analysis_job', {
      jobId: claims[0].job.id,
      claimToken: claims[0].claimToken,
      retryAfterSeconds: 1,
      error: { code: 'fixture_failure', message: 'Synthetic retryable failure', retryable: true },
    });
    if (attempt < 3) await Bun.sleep(1100);
  }
  const metrics = invoke('get_analysis_metrics', {});
  if (
    metrics.deadLetter !== 1 ||
    metrics.completed !== 1 ||
    metrics.pending !== 0 ||
    metrics.claimed !== 0
  )
    throw new Error('Queue metrics mismatch');
  console.log(
    JSON.stringify({
      passed: true,
      deadLetter: metrics.deadLetter,
      completed: metrics.completed,
      pending: metrics.pending,
      claimed: metrics.claimed,
    }),
  );
} else if (mode === 'check') {
  try {
    const jobs = await store.repos.analysis.listJobs({ accountId: 'default-account', limit: 10 });
    const advices = await store.repos.advice.query({ includeExpired: true });
    const passed =
      jobs.length === 1 &&
      jobs[0]?.status === 'completed' &&
      jobs[0]?.attempts === 1 &&
      advices.length === 1 &&
      advices[0]?.provenance?.generatorKind === 'dsh-headless';
    console.log(
      JSON.stringify({
        passed,
        jobs: jobs.map((job) => ({
          status: job.status,
          attempts: job.attempts,
          error: job.error?.code,
        })),
        adviceCount: advices.length,
        generator: advices[0]?.provenance?.generatorKind,
      }),
    );
    if (!passed) process.exitCode = 1;
  } finally {
    store.close();
  }
} else {
  store.close();
  throw new Error('Expected seed, check or faults');
}
