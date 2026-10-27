// MVP 最终验收编排（task-20）：先跑 Node 24 完整旅程，再在 Node 24 + 真实 DSH CLI 中
// 加载构建后的插件，执行一次真实只读工具和一次原生确认写入。
//
// 说明：模型仍是**脚本模型**，这里验证的是协议/装配/审批/Node SQLite 链路，不是真实模型质量。
// 全部临时 DSH_HOME/profile/任务库都在 /tmp；不触碰用户 profile、真实个人库或生产服务器。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');
const packageDir = join(repo, 'packages/dsh-luoome');
const dshModules = resolve(repo, 'node_modules/.bun/node_modules');
const cli = resolve(dshModules, '@deepseek-ai/dsh/lib/bin.js');
const node24Command = process.env.NODE24_PATH ?? 'npx';
const node24 = process.env.NODE24_PATH ? [] : ['--yes', 'node@24'];
const owner = Object.freeze({
  userId: 'mvp-node24-owner',
  accountId: 'mvp-node24-account',
});
const profileName = 'luoome-mvp-node24';
const root = await mkdtemp(join(tmpdir(), 'luoome-mvp-node24-'));
const workspace = join(root, 'workspace');
const profileDir = join(root, 'profiles', profileName);
const luoomeHome = join(root, 'luoome-home');
const children: ReturnType<typeof spawn>[] = [];
const summary: Record<string, unknown> = {};

const run = (command: string, args: readonly string[], options: { cwd?: string } = {}) => {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd ?? repo,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, npm_config_yes: 'true' },
    timeout: 600_000,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed (${String(result.status)}):\n${result.stderr ?? ''}\n${result.stdout ?? ''}`,
    );
  return result.stdout.trim();
};

const waitFor = async (predicate: () => string | undefined, timeoutMs: number, label: string) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`${label} did not become ready in ${String(timeoutMs)}ms`);
};

const terminate = async (child: ReturnType<typeof spawn>): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((done) => child.once('close', () => done()));
};

const login = async (startup: string): Promise<string> => {
  const response = await fetch(startup, { redirect: 'manual' });
  if (response.status !== 303)
    throw new Error(`DSH web login expected 303, received ${String(response.status)}`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined) throw new Error('DSH web login did not issue a signed cookie');
  return cookie;
};

const api = async (
  origin: string,
  cookie: string,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ status: number; value: Record<string, unknown> }> => {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      cookie,
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, value: (await response.json()) as Record<string, unknown> };
};

try {
  await mkdir(workspace, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await mkdir(luoomeHome, { recursive: true });

  // A. Node 24 完整旅程（真实 AgentLoop/ApprovalService + Node SQLite，脚本模型）。
  const nodeVersion = run(node24Command, [...node24, '--version']);
  if (!nodeVersion.trim().startsWith('v24.'))
    throw new Error('Node 24 is required for this acceptance');
  const journeys = spawnSync(
    node24Command,
    [
      ...node24,
      'node_modules/vitest/vitest.mjs',
      'run',
      'packages/dsh-luoome/src/host/mvp-journeys.e2e.test.ts',
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, npm_config_yes: 'true' },
      timeout: 600_000,
    },
  );
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const journeysOutput = `${journeys.stdout ?? ''}${journeys.stderr ?? ''}`.replace(ansi, '');
  const journeysTests = /Tests\s+(\d+)\s+passed/.exec(journeysOutput)?.[1];
  const journeysFiles = /Test Files\s+(\d+)\s+passed/.exec(journeysOutput)?.[1];
  if (journeys.status !== 0)
    throw new Error(`Node 24 journeys failed:\n${journeysOutput.slice(-6000)}`);

  // B. 构建生产插件并安装到临时 profile。
  run('bun', ['--no-env-file', 'run', 'build:dsh-luoome']);
  const profileModules = join(profileDir, 'node_modules');
  await mkdir(profileModules, { recursive: true });
  for (const entry of await readdir(dshModules)) {
    if (entry.startsWith('.')) continue;
    await symlink(join(dshModules, entry), join(profileModules, entry), 'dir');
  }
  const installedDir = join(profileModules, 'dsh-luoome');
  await mkdir(join(installedDir, 'dist'), { recursive: true });
  await writeFile(
    join(installedDir, 'package.json'),
    await readFile(join(packageDir, 'package.json')),
  );
  await writeFile(
    join(installedDir, 'dist', 'host.js'),
    await readFile(join(packageDir, 'dist', 'host.js')),
  );
  await cp(join(packageDir, 'skills'), join(installedDir, 'skills'), { recursive: true });
  await writeFile(
    join(profileDir, 'package.json'),
    `${JSON.stringify({
      name: `dsh-profile-${profileName}`,
      private: true,
      type: 'module',
      dependencies: { 'dsh-luoome': 'file:./dsh-luoome' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    })}\n`,
  );
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n');
  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    `${JSON.stringify(
      [
        { id: 'session-title-llm', disabled: true },
        { id: 'llm-deepseek', disabled: true },
        { id: 'llm-deepseek-account', disabled: true },
        { id: 'llm-pi-ai', disabled: true },
        { id: 'approval', config: { policy: 'ask' } },
        { id: 'hmr', disabled: true },
        { id: 'working-directory', config: { defaultDirectory: workspace } },
        { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: workspace } },
        { id: 'workspace-controller', config: { documentsDirectory: join(root, 'documents') } },
        { insert: [{ id: 'luoome-plugin', name: 'dsh-luoome' }] },
      ],
      null,
      2,
    )}\n`,
  );

  // C. 用 Node 24 跑一次生产 composition：建 schema/账户，并写入一份合法的 advice_market
  //    AnalysisContext（哈希按领域 analysisHash 同口径计算）。这一子进程同时证明 node:sqlite 可用。
  const contextId = `ctx-mvp-node24-${Date.now()}`;
  const dataAsOf = new Date(Math.floor(Date.now() / 1000) * 1000);
  const contextFacts = [
    {
      id: 'market:index:000001.SH',
      label: '合成指数事实',
      value: {
        code: '000001.SH',
        close: 3200,
        source: 'mvp-node24-synthetic',
        dataAsOf: dataAsOf.toISOString(),
      },
      evidenceIds: [],
    },
  ];
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  };
  const analysisHash = (value: unknown) =>
    createHash('sha256').update(canonical(value)).digest('hex');
  const seedCode = `
const { createProductionHost } = await import(process.env.PLUGIN_HOST);
const { DatabaseSync } = await import('node:sqlite');
const home = process.env.LUOOME_HOME;
const owner = JSON.parse(process.env.PLUGIN_OWNER);
const raw = JSON.parse(process.env.PLUGIN_CONTEXT);
const context = {
  ...raw,
  dataAsOf: new Date(raw.dataAsOf),
  writeUntil: new Date(raw.writeUntil),
  expiresAt: new Date(raw.expiresAt),
  createdAt: new Date(raw.createdAt),
};
try {
  const host = await createProductionHost({ home, owner, env: { LUOOME_MARKET_PROVIDER: 'real' } });
  host.dispose();
  throw new Error('owner account unexpectedly existed');
} catch (error) {
  if (!/owner account does not exist/.test(String(error))) throw error;
}
const db = new DatabaseSync(home + '/luoome.db');
db.prepare('INSERT INTO accounts (id, name, kind, currency, initial_capital, cash_balance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(owner.accountId, 'MVP Node24', 'real', 'CNY', 1000000, 1000000, Date.now());
db.close();
const host = await createProductionHost({ home, owner, env: { LUOOME_MARKET_PROVIDER: 'real' } });
await host.context.repos.analysis.saveContext(context);
host.dispose();
process.stdout.write('seeded');
`;
  const seed = spawnSync(node24Command, [...node24, '--input-type=module', '-e', seedCode], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      npm_config_yes: 'true',
      LUOOME_HOME: luoomeHome,
      PLUGIN_HOST: join(installedDir, 'dist', 'host.js'),
      PLUGIN_OWNER: JSON.stringify(owner),
      PLUGIN_CONTEXT: JSON.stringify({
        id: contextId,
        jobId: null,
        kind: 'advice_market',
        accountId: owner.accountId,
        subject: { kind: 'market', id: 'CN_A_SHARES' },
        dataAsOf,
        facts: contextFacts,
        factIds: contextFacts.map((fact) => fact.id),
        limitations: ['MVP Node24 合成市场事实'],
        contextHash: analysisHash({ facts: contextFacts, dataAsOf }),
        writeUntil: new Date(dataAsOf.getTime() + 24 * 3_600_000),
        expiresAt: new Date(dataAsOf.getTime() + 7 * 86_400_000),
        createdAt: dataAsOf,
      }),
    },
    timeout: 300_000,
  });
  if (seed.status !== 0) throw new Error(`Node 24 seeding failed: ${seed.stderr || seed.stdout}`);

  // D. 用 Node 24 启动真实 DSH CLI（Web profile + 已安装插件）。
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    npm_config_yes: 'true',
    DSH_HOME: root,
    DSH_AGENTS_HOME: join(root, 'agents'),
    LUOOME_HOME: luoomeHome,
    LUOOME_OWNER_USER_ID: owner.userId,
    LUOOME_OWNER_ACCOUNT_ID: owner.accountId,
    LUOOME_MARKET_PROVIDER: 'real',
  };
  const child = spawn(
    node24Command,
    [...node24, cli, '--profile', profileName, '--no-open', '--port', '0'],
    { cwd: workspace, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((done) => child.once('close', (code) => done(code)));
  const startup = await waitFor(
    () => /dsh web: (\S+)/.exec(output)?.[1],
    120_000,
    'Node 24 DSH web',
  );
  const origin = new URL(startup).origin;
  const cookie = await login(startup);
  const profile = await api(origin, cookie, '/api/luoome/profile', 'GET');
  if (profile.status !== 200) throw new Error(`profile route failed: ${JSON.stringify(profile)}`);
  const profileData = profile.value as { accountId?: string; readTools?: string[] };
  if (profileData.accountId !== owner.accountId)
    throw new Error(`owner mismatch: ${JSON.stringify(profileData.accountId)}`);

  // 真实只读工具
  const read = await api(origin, cookie, '/api/luoome/call', 'POST', {
    tool: 'list_accounts',
    input: {},
  });
  const readData = read.value as { ok?: boolean; data?: { accounts?: { id?: string }[] } };
  if (
    read.status !== 200 ||
    readData.ok !== true ||
    readData.data?.accounts?.[0]?.id !== owner.accountId
  )
    throw new Error(`read tool failed: ${JSON.stringify(read)}`);

  // 一次原生确认写入：prepare 冻结 → confirm（一次性 token）→ 读回同一 Advice
  const prepare = await api(origin, cookie, '/api/luoome/operations/prepare', 'POST', {
    id: crypto.randomUUID(),
    tool: 'record_advice',
    input: {
      contextId,
      result: {
        decision: 'watch',
        confidence: 50,
        horizon: 'short',
        reasoning: {
          premise: 'MVP Node24 合成结论',
          evidence: ['market:index:000001.SH'],
          counterEvidence: ['合成事实不代表真实市场'],
        },
        risks: ['合成事实风险'],
      },
      provenance: { generatorKind: 'legacy-ai', evidenceFactIds: ['market:index:000001.SH'] },
    },
  });
  const prepared = prepare.value as {
    ok?: boolean;
    data?: { operationId?: string; state?: string; confirmationToken?: string };
  };
  if (prepare.status !== 200 || prepared.ok !== true || prepared.data?.state !== 'pending')
    throw new Error(`prepare failed: ${JSON.stringify(prepare)}`);
  const operationId = prepared.data.operationId ?? '';
  const token = prepared.data.confirmationToken ?? '';
  const confirm = await api(
    origin,
    cookie,
    `/api/luoome/operations/${encodeURIComponent(operationId)}/confirm`,
    'POST',
    { token },
  );
  const confirmed = confirm.value as { ok?: boolean; data?: { state?: string } };
  if (confirm.status !== 200 || confirmed.ok !== true || confirmed.data?.state !== 'succeeded')
    throw new Error(`confirm failed: ${JSON.stringify(confirm)}`);
  const advice = await api(origin, cookie, '/api/luoome/call', 'POST', {
    tool: 'get_advice',
    input: { includeExpired: true },
  });
  const adviceText = JSON.stringify(advice.value);
  if (!adviceText.includes(`analysis:${contextId}`))
    throw new Error(`written Advice not readable back: ${adviceText.slice(0, 500)}`);

  await terminate(child);
  const exitCode = await exited;
  const bundled = await stat(join(packageDir, 'dist', 'host.js'));
  Object.assign(summary, {
    mode: '协议/装配/审批链路验收，非真实模型质量',
    node24RealVersion: nodeVersion,
    node24Journeys: { files: journeysFiles, tests: journeysTests, exit: journeys.status },
    plugin: {
      bundleBytes: bundled.size,
      installedAs: 'temp DSH profile node_modules/dsh-luoome (built dist)',
      dshExit: exitCode,
    },
    dshWeb: {
      readTool: { tool: 'list_accounts', accountId: readData.data?.accounts?.[0]?.id },
      readToolCount: profileData.readTools?.length ?? 0,
      confirmedWrite: {
        tool: 'record_advice',
        prepare: 'pending + one-time token',
        confirm: confirmed.data?.state,
        readBack: `analysis:${contextId}`,
      },
    },
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      { error: error instanceof Error ? error.message : String(error), root },
      null,
      2,
    ),
  );
  console.error(`mvp-node24 acceptance root kept: ${root}`);
  process.exitCode = 1;
} finally {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  if (process.exitCode !== 1) await rm(root, { recursive: true, force: true });
}
