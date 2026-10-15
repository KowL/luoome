import { existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createDrizzlePlatformRepos,
  createSqliteMaintenanceGate,
  PLATFORM_SCHEMA_VERSION,
} from '@luoome/db';
import { getHostedLLMCostsTool } from '@luoome/tools/platform';
import { createHostedBackup } from '../../web/src/hosted-backup.js';
import { assertHostedEnvironmentIsolation, loadHostedConfig } from '../../web/src/hosted-config.js';
import {
  createHostedOperatorContext,
  prepareHostedRestore,
  reconcileHostedExternalResults,
  reconcileHostedRestoredData,
  resumeHostedRestoredService,
  summarizeHostedRecovery,
} from '../../web/src/hosted-recovery.js';

export const runHostedOperations = async (
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
) => {
  const command = args[0];
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    strict: true,
    allowPositionals: false,
    options: {
      source: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      destination: { type: 'string' },
      'data-root': { type: 'string' },
      'deletion-ledger': { type: 'string' },
      'writers-stopped': { type: 'boolean', default: false },
    },
  });
  if (
    positionals.length !== 0 ||
    ![
      'backup',
      'restore',
      'reconcile',
      'reconcile-external',
      'resume',
      'status',
      'llm-costs',
      'recover-stopped-writers',
    ].includes(command ?? '')
  )
    throw new Error('unknown_hosted_operation');
  const config = loadHostedConfig(env);
  const required = (name: 'source' | 'destination' | 'data-root' | 'deletion-ledger') => {
    const value = values[name];
    if (value === undefined) throw new Error(`missing_${name}`);
    return resolve(value);
  };
  const dataRoot = values['data-root'] === undefined ? config.dataRoot : required('data-root');
  if (command === 'restore')
    return prepareHostedRestore({
      source: required('source'),
      destination: required('destination'),
      deletionLedger: required('deletion-ledger'),
      config,
      writersStopped: values['writers-stopped'] === true,
    });
  if (command === 'reconcile')
    return reconcileHostedRestoredData({
      dataRoot,
      deletionLedger: required('deletion-ledger'),
      config,
      writersStopped: values['writers-stopped'] === true,
    });
  if (command === 'reconcile-external')
    return reconcileHostedExternalResults({
      dataRoot,
      config,
      env,
      writersStopped: values['writers-stopped'] === true,
    });
  if (command === 'resume') {
    await resumeHostedRestoredService({
      dataRoot,
      writersStopped: values['writers-stopped'] === true,
    });
    return { status: 'resumed' };
  }
  const controlPath = join(dataRoot, 'control.sqlite');
  for (const path of [controlPath, `${controlPath}-wal`, `${controlPath}-shm`]) {
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()))
      throw new Error('invalid_control_storage');
  }
  if (!existsSync(controlPath)) throw new Error('control_database_missing');
  const handle = createDrizzlePlatformRepos(controlPath, { migrate: false });
  try {
    const version = handle.sqlite
      .query('SELECT version FROM hosted_schema_versions WHERE id = 1')
      .get() as { version: number } | null;
    if (version?.version !== PLATFORM_SCHEMA_VERSION)
      throw new Error('unsupported_platform_schema');
    const gate = createSqliteMaintenanceGate(handle.sqlite);
    if (command === 'recover-stopped-writers') {
      if (values['writers-stopped'] !== true)
        throw new Error('maintenance_recovery_requires_stopped_writers');
      gate.recoverStoppedWriters({ owner: `restore:${crypto.randomUUID()}`, writersStopped: true });
      return await reconcileHostedRestoredData({
        dataRoot,
        deletionLedger: required('deletion-ledger'),
        config,
        writersStopped: true,
      });
    }
    if (command === 'llm-costs') {
      const result = await getHostedLLMCostsTool.execute(
        {
          ...(values.since === undefined ? {} : { since: values.since }),
          ...(values.until === undefined ? {} : { until: values.until }),
        },
        createHostedOperatorContext(handle.repos, config),
      );
      if (!result.ok) throw new Error(result.error.kind);
      return result.data;
    }
    if (command === 'status')
      return {
        maintenance: gate.state(),
        pendingReview: await summarizeHostedRecovery(
          createHostedOperatorContext(handle.repos, config),
        ),
      };
    const manifest = await createHostedBackup({
      dataRoot,
      destination: required('destination'),
      gate,
      productPolicyVersion: config.productPolicyVersion,
    });
    return {
      backupId: manifest.backupId,
      createdAt: manifest.createdAt,
      files: manifest.files.length,
      status: 'created',
    };
  } finally {
    handle.close();
  }
};

if (import.meta.main) {
  try {
    assertHostedEnvironmentIsolation();
    console.info(JSON.stringify(await runHostedOperations(process.argv.slice(2))));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const kind =
      /^[a-z_][a-z0-9_.:-]*$/.test(message) || message.startsWith('invalid hosted configuration:')
        ? message
        : 'hosted_operation_failed';
    console.error(JSON.stringify({ ok: false, error: kind }));
    process.exitCode = 1;
  }
}
