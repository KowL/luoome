// M5 默认部署切换/回退隔离演练（需求文档 §9 M5、§10.1、§11；plugin 详细设计 §8）。
//
// 覆盖：
//   1. 用构建产物（本地 tarball）经部署同款安装步骤 `deploy/dsh/profile-seed.mjs` 装配临时
//      DSH profile，再用真实 DSH CLI（Node，非 Bun）启动完整 DSH Web；
//   2. 三面板（overview/strategies/review）state 路由可加载，client bundle 经 boot graph 提供；
//   3. 四条随包技能可见且无旧 MCP 技能；
//   4. 一行真实只读工具（list_accounts）与一条宿主确认写入（create_strategy，隔离库）；
//   5. Node SQLite 重开持久化；
//   6. 运行进程/环境无 MCP client/server、Bun CLI、旧 Bun Web、analysis worker、queue probe；
//   7. 一致性备份（node:sqlite backup API，不复制活跃 WAL 主文件）→ 回退演练到切换前副本
//      并核对/合并备份后新增事实，不覆盖新增事实；
//   8. `docker compose config` 静态断言默认部署只有纯插件 Web + Caddy。
//
// 明确标注：这是「部署切换/回退协议与数据演练」，使用合成事实库与受控 profile；
// 不启动模型、不验证真实模型质量、不操作真实服务器/个人库，不代表生产已完成切换。
// 运行：bun --no-env-file infra/dsh/plugin-switch-acceptance.ts
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');
const packageDir = join(repo, 'packages/dsh-luoome');
const cli = resolve(repo, 'node_modules/.bun/node_modules/@deepseek-ai/dsh/lib/bin.js');
const dshModules = resolve(repo, 'node_modules/.bun/node_modules');
const profileName = 'luoome-switch';
const owner = Object.freeze({
  userId: 'switch-drill-owner',
  accountId: 'switch-drill-account',
});
const READ_TOOL_COUNT = 63;
const MARKET_TOOL_COUNT = 8;
const SKILL_NAMES = [
  'daily-market-analysis',
  'post-close-review',
  'strategy-lab',
  'strategy-result-review',
] as const;
const LEGACY_SKILL_NAMES = ['analysis-worker', 'stock-deep-dive', 'morning-brief', 'luoome-batch'];
const PANEL_TOOL_NAMES = {
  overview: [
    'list_accounts',
    'list_holdings',
    'list_watch_triggers',
    'get_advice',
    'get_market_data_status',
    'get_ashare_sentiment',
    'fetch_index_quotes',
  ],
  strategies: [
    'list_strategies',
    'get_watch_status',
    'get_strategy_reliability_summary',
    'list_strategy_runs',
    'list_pending_strategy_observations',
  ],
  review: [
    'get_advice_stats',
    'get_confidence_calibration',
    'list_decision_reviews',
    'get_advice',
    'get_decision_loop_review',
    'list_pending_strategy_observations',
  ],
} as const;
const CLIENT_BUNDLE_LIMIT_BYTES = 800 * 1024;
const strategyName = 'M5 切换演练策略';

interface Descendant {
  readonly pid: number;
  readonly command: string;
}

const root = mkdtempSync(join(tmpdir(), 'luoome-plugin-switch-'));
const workspace = join(root, 'workspace');
const profileDir = join(root, 'profiles', profileName);
const luoomeHome = join(root, 'luoome-home');
const backupDir = join(root, 'backup');
const children: ReturnType<typeof spawn>[] = [];
const launched: { output: () => string }[] = [];
const summary: Record<string, unknown> = {};

const run = (command: string, args: readonly string[], options: { cwd?: string } = {}) => {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd ?? repo,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed (${String(result.status)}):\n${result.stderr || result.stdout}`,
    );
  return result;
};

const runNode = (code: string, env: Record<string, string | undefined>, cwd = root): string => {
  const result = spawnSync('node', ['--input-type=module', '-e', code], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  if (result.status !== 0)
    throw new Error(`node helper failed (${String(result.status)}):\n${result.stderr}`);
  // node:sqlite 在 Node 22 会向 stderr 打 ExperimentalWarning；只取 stdout 的 JSON。
  return result.stdout.trim();
};

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const profile = async (origin: string, cookie: string, path: string, init: RequestInit = {}) => {
  if (process.env.ACCEPTANCE_TRACE === '1')
    console.error(`[trace] ${init.method ?? 'GET'} ${path.slice(0, 120)}`);
  return fetch(`${origin}${path}`, {
    ...init,
    headers: {
      cookie,
      origin,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    redirect: 'manual',
  });
};

const login = async (startup: string): Promise<string> => {
  const response = await fetch(startup, { redirect: 'manual' });
  if (response.status !== 303)
    throw new Error(`DSH web login expected 303, received ${String(response.status)}`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined) throw new Error('DSH web login did not issue a signed cookie');
  return cookie;
};

const waitForReady = async (fixture: {
  child: ReturnType<typeof spawn>;
  output: () => string;
}): Promise<string> => {
  for (let i = 0; i < 2000; i++) {
    const match = /dsh web: (\S+)/.exec(fixture.output());
    if (match?.[1] !== undefined) return match[1];
    if (fixture.child.exitCode !== null)
      throw new Error(`DSH web exited before ready:\n${fixture.output()}`);
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`DSH web did not become ready:\n${fixture.output()}`);
};

const waitForJsonFile = async (path: string): Promise<Record<string, unknown>> => {
  for (let i = 0; i < 1500; i++) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      await new Promise((done) => setTimeout(done, 20));
    }
  }
  throw new Error(`probe did not write ${path}`);
};

const launch = (env: NodeJS.ProcessEnv) => {
  const child = spawn('node', [cli, '--profile', profileName, '--no-open', '--port', '0'], {
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.once('close', (code, signal) => done({ code, signal })),
  );
  const fixture = { child, exited, output: () => output };
  launched.push(fixture);
  return fixture;
};

const terminate = async (
  fixture: ReturnType<typeof launch>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
  if (fixture.child.exitCode === null && fixture.child.signalCode === null)
    fixture.child.kill('SIGTERM');
  return fixture.exited;
};

const descendantsOf = (pid: number): Descendant[] => {
  const listing = spawnSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
  }).stdout;
  const rows: { pid: number; ppid: number; command: string }[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined)
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  const found: Descendant[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) continue;
    for (const row of rows) {
      if (row.ppid !== parent) continue;
      found.push({ pid: row.pid, command: row.command });
      queue.push(row.pid);
    }
  }
  return found;
};

const forbiddenProcess = (command: string): string | undefined => {
  const executable = command.trim().split(/\s+/)[0] ?? '';
  if (executable === 'bun' || executable.endsWith('/bun')) return 'bun';
  for (const needle of [
    'luoome-mcp',
    'mcp-server',
    'analysis-worker',
    'queue-probe',
    'luoome/cli',
    'apps/web/src/index.ts',
  ])
    if (command.includes(needle)) return needle;
  return undefined;
};

const readApi = async (
  origin: string,
  cookie: string,
  tool: string,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const response = await profile(origin, cookie, '/api/luoome/call', {
    method: 'POST',
    body: JSON.stringify({ tool, input }),
  });
  const value = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200)
    throw new Error(`/api/luoome/call ${tool} returned ${String(response.status)}`);
  return value;
};

const postOperation = async (
  origin: string,
  cookie: string,
  path: string,
  body: unknown,
): Promise<{ status: number; value: Record<string, unknown> }> => {
  const response = await profile(origin, cookie, path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { status: response.status, value: (await response.json()) as Record<string, unknown> };
};

const installProfile = (tarball: string) => {
  const result = run('node', [
    join(repo, 'deploy/dsh/profile-seed.mjs'),
    '--plugin',
    tarball,
    '--profile',
    profileName,
    '--home',
    root,
    '--modules',
    dshModules,
  ]);
  const seed = JSON.parse(result.stdout) as Record<string, unknown>;
  if (seed.ok !== true) throw new Error(`profile seed did not succeed: ${result.stdout}`);
  // 演练 profile 额外挂只读 skills catalog probe 并禁用无关模型适配器；
  // 生产 seed 只写 luoome-plugin 一条补丁（见 deploy/dsh/profile-seed.mjs）。
  const probeDir = join(profileDir, 'node_modules', 'luoome-skills-probe');
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(
    join(probeDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'luoome-skills-probe',
        version: '0.0.0',
        private: true,
        type: 'module',
        main: './index.js',
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(probeDir, 'index.js'),
    `import { writeFileSync } from 'node:fs';
export const name = 'luoome-skills-probe';
export const inject = ['skills'];
const EXPECTED = ${JSON.stringify(SKILL_NAMES)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const apply = async (ctx) => {
  const report = { ok: false, error: null, skills: [] };
  try {
    let catalog = [];
    for (let attempt = 0; attempt < 600; attempt += 1) {
      catalog = await ctx.skills.list({ cwd: process.env.LUOOME_SKILLS_CWD });
      if (EXPECTED.every((name) => catalog.some((skill) => skill.name === name))) break;
      await sleep(25);
    }
    const skills = [];
    for (const item of catalog) {
      const definition = await ctx.skills.get(item.name, { cwd: process.env.LUOOME_SKILLS_CWD });
      skills.push({
        name: item.name,
        description: item.description,
        source: item.source,
        provider: item.provider,
        contentLength: definition?.content.length ?? 0,
      });
    }
    const missing = EXPECTED.filter((name) => !skills.some((skill) => skill.name === name));
    report.skills = skills;
    report.ok = missing.length === 0;
    report.error = missing.length === 0 ? null : 'missing: ' + missing.join(', ');
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  writeFileSync(process.env.LUOOME_SKILLS_OUT, JSON.stringify(report));
};
`,
  );
  const patch = [
    { id: 'session-title-llm', disabled: true },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'llm-pi-ai', disabled: true },
    { id: 'approval', config: { policy: 'ask' } },
    { id: 'hmr', disabled: true },
    { id: 'working-directory', config: { defaultDirectory: workspace } },
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: workspace } },
    { id: 'workspace-controller', config: { documentsDirectory: join(root, 'documents') } },
    {
      insert: [
        { id: 'luoome-plugin', name: 'dsh-luoome' },
        { id: 'luoome-skills-probe', name: 'luoome-skills-probe' },
      ],
    },
  ];
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `${JSON.stringify(patch, null, 2)}\n`);
  return seed;
};

const sqliteTool = () => {
  const toolPath = join(root, 'sqlite-tool.mjs');
  writeFileSync(
    toolPath,
    `import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
const op = process.env.OP;
const report = (db) => ({
  integrity: db.prepare('pragma integrity_check').get().integrity_check,
  accounts: db.prepare('select count(*) c from accounts').get().c,
  strategies: db.prepare('select count(*) c from strategies').get().c,
  strategyIds: db.prepare('select id from strategies order by id').all().map((row) => row.id),
  accountsFingerprint: db.prepare('select id, name, kind, currency, initial_capital, cash_balance, created_at from accounts order by id').all(),
});
if (op === 'snapshot') {
  const db = new DatabaseSync(process.env.SOURCE);
  await backup(db, process.env.TARGET);
  db.close();
  const copy = new DatabaseSync(process.env.TARGET, { readOnly: true });
  const value = report(copy);
  copy.close();
  writeFileSync(process.env.OUT, JSON.stringify(value));
} else if (op === 'report') {
  const db = new DatabaseSync(process.env.SOURCE, { readOnly: true });
  const value = report(db);
  db.close();
  writeFileSync(process.env.OUT, JSON.stringify(value));
} else if (op === 'reconcile') {
  // 回退演练：把备份后新增的策略事实从切换后快照合并进回退副本，不覆盖任何既有行。
  const db = new DatabaseSync(process.env.TARGET);
  db.exec(\`ATTACH DATABASE '\${process.env.SOURCE.replaceAll("'", "''")}' AS post\`);
  const columns = db.prepare('pragma main.table_info(strategies)').all().map((row) => row.name);
  const placeholders = columns.map(() => '?').join(', ');
  const insert = db.prepare(
    \`INSERT INTO main.strategies (\${columns.join(', ')}) VALUES (\${placeholders})\`,
  );
  const before = db.prepare('select count(*) c from main.strategies').get().c;
  const sourceRows = db.prepare('select * from post.strategies').all();
  for (const row of sourceRows) {
    const exists = db.prepare('select 1 from main.strategies where id = ?').get(row.id);
    if (exists) continue;
    insert.run(...columns.map((column) => row[column]));
  }
  db.exec('DETACH DATABASE post');
  const value = report(db);
  value.mergedStrategies = value.strategies - before;
  db.close();
  writeFileSync(process.env.OUT, JSON.stringify(value));
} else {
  throw new Error('unknown sqlite tool operation: ' + String(op));
}
`,
  );
  const call = (
    op: 'snapshot' | 'report' | 'reconcile',
    source: string,
    target: string,
    out: string,
  ): Record<string, unknown> => {
    runNode(
      readFileSync(toolPath, 'utf8'),
      { SOURCE: source, TARGET: target, OUT: out, OP: op },
      root,
    );
    return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
  };
  return { call };
};

const composeCheck = (): Record<string, unknown> => {
  const composeFile = join(repo, 'deploy/dsh/compose.yaml');
  const composeText = readFileSync(composeFile, 'utf8');
  const entrypoint = readFileSync(join(repo, 'deploy/dsh/entrypoint.sh'), 'utf8');
  const envExample = readFileSync(join(repo, 'deploy/dsh/production.env.example'), 'utf8');
  const dockerfile = readFileSync(join(repo, 'deploy/dsh/Dockerfile'), 'utf8');
  const forbiddenDeploy = [
    'dsh-worker',
    'DSH_WORKER_',
    'LUOOME_MCP_',
    'luoome-worker',
    'luoome-analysis',
    'analysis-worker',
    'queue-probe',
    '172.28.0.6',
  ];
  for (const needle of forbiddenDeploy) {
    if (composeText.includes(needle)) throw new Error(`compose.yaml still contains ${needle}`);
    if (envExample.includes(needle))
      throw new Error(`production.env.example still contains ${needle}`);
  }
  for (const required of [
    '${LUOOME_RELEASE:?',
    '${LUOOME_OWNER_USER_ID:?',
    '${LUOOME_OWNER_ACCOUNT_ID:?',
    '${DSH_PUBLIC_URL:?',
    '${DSH_TRUSTED_HOST:?',
  ])
    if (!composeText.includes(required)) throw new Error(`compose.yaml missing ${required}`);
  if (!entrypoint.includes('profile-seed.mjs'))
    throw new Error('entrypoint.sh must seed the pure-plugin profile');
  if (/\bbun\b/.test(entrypoint)) throw new Error('entrypoint.sh must not require bun at runtime');
  if (entrypoint.includes('bootstrap.ts') || entrypoint.includes('queue-probe'))
    throw new Error('entrypoint.sh still references legacy MCP/worker entrypoints');
  const runtimeMarker = /^FROM \$\{NODE_IMAGE\}/m.exec(dockerfile)?.index ?? -1;
  const runtimeStage = runtimeMarker < 0 ? '' : dockerfile.slice(runtimeMarker);
  if (/\bbun\b/.test(runtimeStage)) throw new Error('runtime stage must not require bun');
  if (!dockerfile.includes('bun pm pack'))
    throw new Error('build stage must pack the plugin with bun');

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LUOOME_RELEASE: 'switch-acceptance-release',
    BUN_IMAGE: 'oven/bun:1.3.14',
    NODE_IMAGE: 'node:22.22.3-bookworm-slim',
    DSH_VERSION: '0.2.1-rc.2',
    CADDY_IMAGE: 'caddy:2.10.2-alpine',
    DSH_PROFILE: profileName,
    DSH_BIND_HOST: '172.28.0.5',
    DSH_PORT: '3080',
    DSH_PUBLIC_URL: 'http://acceptance.invalid/dsh/',
    DSH_TRUSTED_HOST: 'acceptance.invalid',
    LUOOME_OWNER_USER_ID: owner.userId,
    LUOOME_OWNER_ACCOUNT_ID: owner.accountId,
  };
  const services = spawnSync(
    'docker',
    ['compose', '-f', composeFile, 'config', '--format', 'json'],
    {
      encoding: 'utf8',
      env,
    },
  );
  if (services.status !== 0)
    throw new Error(
      `docker compose config --format json failed: ${services.stderr || services.stdout}`,
    );
  const resolved = JSON.parse(services.stdout) as {
    services: Record<
      string,
      {
        environment?: Record<string, string | null>;
        build?: { args?: Record<string, string> };
      }
    >;
  };
  const serviceNames = Object.keys(resolved.services).sort();
  if (serviceNames.join(',') !== 'caddy,dsh-web')
    throw new Error(`default compose services must be caddy,dsh-web: ${serviceNames.join(',')}`);
  const web = resolved.services['dsh-web'];
  if (web === undefined) throw new Error('resolved compose config is missing dsh-web');
  const webEnvironment = web.environment ?? {};
  for (const key of Object.keys(webEnvironment))
    if (/^LUOOME_MCP_|^DSH_WORKER_/.test(key))
      throw new Error(`resolved dsh-web environment still contains ${key}`);
  for (const needle of ['analysis-worker', 'queue-probe', 'luoome-worker'])
    if (JSON.stringify(webEnvironment).includes(needle))
      throw new Error(`resolved dsh-web environment still contains ${needle}`);
  for (const [key, value] of [
    ['LUOOME_OWNER_USER_ID', owner.userId],
    ['LUOOME_OWNER_ACCOUNT_ID', owner.accountId],
    ['LUOOME_HOME', '/var/lib/luoome'],
    ['LUOOME_MARKET_PROVIDER', 'real'],
    ['DSH_PROFILE', profileName],
    ['DSH_BIND_HOST', '127.0.0.1'],
  ] as const)
    if (webEnvironment[key] !== value)
      throw new Error(`resolved dsh-web environment ${key} must be ${value}`);
  if (webEnvironment.BUN_IMAGE !== undefined)
    throw new Error('resolved dsh-web runtime environment must not include BUN_IMAGE');
  if (web.build?.args?.BUN_IMAGE === undefined)
    throw new Error('build stage must pass BUN_IMAGE (build-only)');
  if (
    !readFileSync(join(repo, 'deploy/dsh/Caddyfile'), 'utf8').includes('reverse_proxy dsh-web:3081')
  )
    throw new Error('Caddy must only proxy the Pocket listener');
  if (!entrypoint.includes('--host 127.0.0.1'))
    throw new Error('entrypoint must pin the Pocket upstream to loopback');
  return {
    services: serviceNames,
    dockerCompose: run('docker', ['compose', 'version']).stdout.trim(),
    resolvedConfigBytes: Buffer.byteLength(services.stdout),
    runtimeEnvironmentKeys: Object.keys(webEnvironment).sort(),
    buildUsesBunOnlyForPackaging: true,
    failClosedVars: [
      'LUOOME_RELEASE',
      'LUOOME_OWNER_USER_ID',
      'LUOOME_OWNER_ACCOUNT_ID',
      'DSH_PUBLIC_URL',
      'DSH_TRUSTED_HOST',
    ],
    caddyOnlyPublicEntry: true,
  };
};

try {
  for (const directory of [workspace, profileDir, luoomeHome, backupDir])
    mkdirSync(directory, {
      recursive: true,
    });

  // 1) 构建 + 打包部署产物（构建阶段允许 Bun；运行阶段只用 Node）。
  run('bun', ['--no-env-file', 'run', 'build:dsh-luoome']);
  const hostBundle = join(packageDir, 'dist', 'host.js');
  const clientBundle = join(packageDir, 'dist', 'client.js');
  const hostBundleSize = statSync(hostBundle).size;
  const clientBundleSize = statSync(clientBundle).size;
  const clientBundleText = readFileSync(clientBundle, 'utf8');
  if (clientBundleSize > CLIENT_BUNDLE_LIMIT_BYTES)
    throw new Error(`client bundle exceeds ${String(CLIENT_BUNDLE_LIMIT_BYTES)} bytes`);
  if (!clientBundleText.includes('__ModuleLoader__.load('))
    throw new Error('client bundle must be loader-wrapped');
  if (!clientBundleText.includes('id:"dsh-luoome"'))
    throw new Error('client bundle must register the dsh-luoome client module');
  const packDir = join(root, 'pack');
  mkdirSync(packDir, { recursive: true });
  run('bun', ['pm', 'pack', '--destination', packDir], { cwd: packageDir });
  const tarballName = readdirSync(packDir).find((name) => name.endsWith('.tgz'));
  if (tarballName === undefined) throw new Error('bun pm pack did not produce a tarball');
  const tarball = join(packDir, tarballName);
  const entries = run('tar', ['-tzf', tarball]).stdout.trim().split('\n');
  const expectedEntries = [
    'package/dist/host.js',
    'package/dist/client.js',
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    ...SKILL_NAMES.map((name) => `package/skills/${name}/SKILL.md`),
  ];
  const fileEntries = entries.filter((entry) => !entry.endsWith('/'));
  if (
    fileEntries.length !== expectedEntries.length ||
    !expectedEntries.every((entry) => entries.includes(entry))
  )
    throw new Error(`unexpected tarball entries: ${JSON.stringify(entries)}`);

  // 2) 切换前事实：隔离 Node SQLite（owner 账户），并做一致性前置备份。
  const seedCode = `
const { createProductionHost } = await import(process.env.PLUGIN_HOST);
const { DatabaseSync } = await import('node:sqlite');
try {
  const host = await createProductionHost({ home: process.env.LUOOME_HOME, owner: JSON.parse(process.env.PLUGIN_OWNER), env: { LUOOME_MARKET_PROVIDER: 'real' } });
  host.dispose();
  throw new Error('owner account unexpectedly existed');
} catch (error) {
  if (!/owner account does not exist/.test(String(error))) throw error;
}
const db = new DatabaseSync(process.env.LUOOME_HOME + '/luoome.db');
db.prepare('INSERT INTO accounts (id, name, kind, currency, initial_capital, cash_balance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(process.env.OWNER_ACCOUNT, '切换前账户', 'real', 'CNY', 1000000, 1000000, Date.now());
db.close();
process.stdout.write('seeded');
`;
  // 先用部署同款安装步骤装配 profile（插件产物进入 DSH profile）。
  const seed = installProfile(tarball);
  const installedHost = join(profileDir, 'node_modules', 'dsh-luoome', 'dist', 'host.js');
  runNode(
    seedCode,
    {
      LUOOME_HOME: luoomeHome,
      PLUGIN_HOST: installedHost,
      PLUGIN_OWNER: JSON.stringify(owner),
      OWNER_ACCOUNT: owner.accountId,
    },
    workspace,
  );
  const preSwitch = sqliteTool().call(
    'snapshot',
    join(luoomeHome, 'luoome.db'),
    join(backupDir, 'pre-switch.db'),
    join(root, 'pre-switch.json'),
  );
  if (preSwitch.integrity !== 'ok' || preSwitch.accounts !== 1 || preSwitch.strategies !== 0)
    throw new Error(
      `pre-switch backup is not the expected isolated state: ${JSON.stringify(preSwitch)}`,
    );

  // 3) 切换：用 Node 启动完整 DSH Web（纯插件 profile；无 MCP/Bun/worker 进程）。
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DSH_HOME: root,
    DSH_AGENTS_HOME: join(root, 'agents'),
    LUOOME_HOME: luoomeHome,
    LUOOME_OWNER_USER_ID: owner.userId,
    LUOOME_OWNER_ACCOUNT_ID: owner.accountId,
    LUOOME_MARKET_PROVIDER: 'real',
    LUOOME_SKILLS_CWD: workspace,
    LUOOME_SKILLS_OUT: join(root, 'skills-catalog.json'),
  };
  for (const key of Object.keys(baseEnv))
    if (/^LUOOME_MCP_|^DSH_WORKER_/.test(key)) throw new Error(`launch env leaks ${key}`);

  const first = launch(baseEnv);
  const firstStartup = await waitForReady(first);
  const firstOrigin = new URL(firstStartup).origin;
  const firstCookie = await login(firstStartup);
  const profileResponse = await profile(firstOrigin, firstCookie, '/api/luoome/profile');
  if (profileResponse.status !== 200)
    throw new Error(`/api/luoome/profile returned ${String(profileResponse.status)}`);
  const pluginProfile = (await profileResponse.json()) as {
    profile?: string;
    accountId?: string;
    automationsEnabled?: boolean;
    readTools?: string[];
    policies?: unknown[];
  };
  if (pluginProfile.profile !== 'dsh-luoome-plugin')
    throw new Error(`unexpected plugin profile: ${JSON.stringify(pluginProfile.profile)}`);
  if (pluginProfile.accountId !== owner.accountId) throw new Error('plugin owner account mismatch');
  if (pluginProfile.automationsEnabled !== false)
    throw new Error('automationsEnabled must be false (default no automations)');
  if ((pluginProfile.readTools ?? []).length !== READ_TOOL_COUNT)
    throw new Error(`read surface has ${String((pluginProfile.readTools ?? []).length)} tools`);

  // 3a) 三面板：client 经 boot graph 提供，state 路由返回固定 panel→工具映射。
  const shell = await profile(firstOrigin, firstCookie, '/');
  if (shell.status !== 200) throw new Error(`DSH shell returned ${String(shell.status)}`);
  const shellHtml = await shell.text();
  if (!shellHtml.includes('dsh-luoome'))
    throw new Error('DSH shell must reference the installed dsh-luoome client module');
  const comboMatch = /plugins\/[^"'\s<>]*dsh-luoome[^"'\s<>]*/.exec(shellHtml);
  if (comboMatch === null) throw new Error('DSH shell must serve the dsh-luoome client bundle');
  const servedClient = await profile(
    firstOrigin,
    firstCookie,
    `/${comboMatch[0].replaceAll('&amp;', '&')}`,
  );
  if (servedClient.status !== 200)
    throw new Error(`served client bundle returned ${String(servedClient.status)}`);
  if (!(await servedClient.text()).includes('__ModuleLoader__.load({id:"dsh-luoome"'))
    throw new Error('served client bundle must register the dsh-luoome module');

  const panels: Record<string, { status: number; toolNames: string[]; noStore: boolean }> = {};
  for (const panel of ['overview', 'strategies', 'review'] as const) {
    const response = await profile(firstOrigin, firstCookie, `/api/luoome/state?panel=${panel}`);
    if (response.status !== 200)
      throw new Error(`/api/luoome/state?panel=${panel} returned ${String(response.status)}`);
    const body = (await response.json()) as {
      panel?: string;
      asOf?: string;
      tools?: { name?: string; ok?: boolean; data?: unknown; error?: unknown }[];
    };
    if (body.panel !== panel || typeof body.asOf !== 'string' || !Array.isArray(body.tools))
      throw new Error(`panel ${panel} state shape mismatch`);
    const toolNames = body.tools.map((tool) => String(tool.name));
    const expected = PANEL_TOOL_NAMES[panel];
    if (toolNames.length !== expected.length || !expected.every((name) => toolNames.includes(name)))
      throw new Error(`panel ${panel} tool mapping mismatch: ${JSON.stringify(toolNames)}`);
    for (const tool of body.tools)
      if (
        typeof tool.ok !== 'boolean' ||
        (tool.ok === true ? tool.data === undefined : tool.error === undefined)
      )
        throw new Error(`panel ${panel} tool ${String(tool.name)} must project data or error`);
    panels[panel] = {
      status: response.status,
      toolNames,
      noStore: response.headers.get('cache-control') === 'no-store',
    };
  }
  const unauthenticatedState = await fetch(`${firstOrigin}/api/luoome/state?panel=overview`, {
    redirect: 'manual',
  });
  if (unauthenticatedState.status !== 401)
    throw new Error('unauthenticated state route must be 401');

  // 3b) 四条技能经真实 DSH skills catalog 可见，旧 MCP 技能不在默认 Web。
  const skillsReport = await waitForJsonFile(join(root, 'skills-catalog.json'));
  if (skillsReport.ok !== true)
    throw new Error(`skill catalog probe failed: ${JSON.stringify(skillsReport)}`);
  const catalogSkills = (skillsReport.skills ?? []) as { name: string; provider?: string }[];
  for (const name of SKILL_NAMES)
    if (!catalogSkills.some((skill) => skill.name === name))
      throw new Error(`skills catalog is missing ${name}`);
  for (const legacy of LEGACY_SKILL_NAMES)
    if (catalogSkills.some((skill) => skill.name === legacy))
      throw new Error(`default Web profile must not install legacy skill ${legacy}`);
  if (catalogSkills.length !== SKILL_NAMES.length)
    throw new Error(
      `skills catalog must contain exactly the four bundled skills: ${JSON.stringify(
        catalogSkills.map((skill) => skill.name),
      )}`,
    );

  // 3c) 一行真实只读工具：宿主认证 read surface 返回真实 ToolResult。
  const accounts = await readApi(firstOrigin, firstCookie, 'list_accounts', {});
  const accountData = accounts.data as { total?: number; accounts?: { id?: string }[] } | undefined;
  if (
    accounts.ok !== true ||
    accountData?.total !== 1 ||
    accountData.accounts?.[0]?.id !== owner.accountId
  )
    throw new Error(`list_accounts did not return the isolated fact: ${JSON.stringify(accounts)}`);

  // 3d) 一条宿主确认写入（隔离库）：prepare 冻结输入 → 一次性 confirmation token → confirm。
  // 这是 DSH 客户端操作表单的 production 路径；模型侧原生 AgentLoop allowed-once 审批由
  // packages/dsh-luoome/src/host/dsh-authority.e2e.test.ts / MVP journeys 覆盖。
  const operationId = randomUUID();
  const prepared = await postOperation(firstOrigin, firstCookie, '/api/luoome/operations/prepare', {
    id: operationId,
    tool: 'create_strategy',
    input: {
      name: strategyName,
      description: 'M5 默认部署切换演练的合成策略（隔离库）',
    },
  });
  const preparedData = (prepared.value.data ?? {}) as {
    state?: string;
    confirmationToken?: string;
  };
  const confirmationToken = preparedData.confirmationToken;
  if (
    prepared.status !== 200 ||
    preparedData.state !== 'pending' ||
    typeof confirmationToken !== 'string'
  )
    throw new Error(
      `prepare did not freeze a pending operation: ${JSON.stringify(prepared.value)}`,
    );
  const confirmed = await postOperation(
    firstOrigin,
    firstCookie,
    `/api/luoome/operations/${operationId}/confirm`,
    { token: confirmationToken },
  );
  const confirmedState = (confirmed.value.data as { state?: string } | undefined)?.state;
  if (confirmed.status !== 200 || confirmedState !== 'succeeded')
    throw new Error(`confirm did not commit the operation: ${JSON.stringify(confirmed.value)}`);
  const strategies = await readApi(firstOrigin, firstCookie, 'list_strategies', {});
  const strategyRows = (strategies.data as { strategies?: { name?: string; id?: string }[] })
    ?.strategies;
  if (!Array.isArray(strategyRows) || !strategyRows.some((row) => row.name === strategyName))
    throw new Error(`written strategy is not readable: ${JSON.stringify(strategies)}`);
  const writtenStrategyId = strategyRows.find((row) => row.name === strategyName)?.id;
  if (writtenStrategyId === undefined) throw new Error('written strategy has no id');

  // 3e) 写工具没有经通用 /call 暴露；/call 仍是只读面。
  const deniedWrite = await profile(firstOrigin, firstCookie, '/api/luoome/call', {
    method: 'POST',
    body: JSON.stringify({ tool: 'record_advice', input: {} }),
  });
  if (deniedWrite.status !== 403)
    throw new Error(`generic /call must reject writes, received ${String(deniedWrite.status)}`);

  // 3f) 运行进程无 MCP/Bun/worker/queue probe 子进程。
  const descendants = descendantsOf(first.child.pid ?? -1);
  const forbidden = descendants.flatMap((entry) => {
    const reason = forbiddenProcess(entry.command);
    return reason === undefined ? [] : [{ ...entry, reason }];
  });
  if (forbidden.length > 0)
    throw new Error(`forbidden child processes: ${JSON.stringify(forbidden)}`);

  // 4) 运行中做一致性备份（node:sqlite backup API；不复制活跃 WAL 主文件）。
  const postSwitch = sqliteTool().call(
    'snapshot',
    join(luoomeHome, 'luoome.db'),
    join(backupDir, 'post-switch.db'),
    join(root, 'post-switch.json'),
  );
  if (
    postSwitch.integrity !== 'ok' ||
    postSwitch.accounts !== 1 ||
    postSwitch.strategies !== 1 ||
    !((postSwitch.strategyIds as string[]) ?? []).includes(writtenStrategyId)
  )
    throw new Error(`live backup did not capture the switch fact: ${JSON.stringify(postSwitch)}`);

  const firstExit = await terminate(first);
  const firstOriginClosed = await fetch(`${firstOrigin}/api/luoome/profile`).then(
    () => false,
    () => true,
  );
  if (!firstOriginClosed) throw new Error('old HTTP origin stayed reachable after exit');

  // 5) 备份自包含 + Node SQLite 重开持久化（再启动一次真实 DSH Web 读取同一事实）。
  const isolatedCopyDir = join(root, 'standalone-backup');
  mkdirSync(isolatedCopyDir, { recursive: true });
  copyFileSync(join(backupDir, 'post-switch.db'), join(isolatedCopyDir, 'luoome.db'));
  const standalone = sqliteTool().call(
    'report',
    join(isolatedCopyDir, 'luoome.db'),
    join(isolatedCopyDir, 'unused.db'),
    join(root, 'standalone.json'),
  );
  if (standalone.integrity !== 'ok' || standalone.strategies !== 1)
    throw new Error(`backup alone is not a self-contained database: ${JSON.stringify(standalone)}`);

  const second = launch(baseEnv);
  const secondStartup = await waitForReady(second);
  const secondOrigin = new URL(secondStartup).origin;
  const secondCookie = await login(secondStartup);
  const reopened = await readApi(secondOrigin, secondCookie, 'list_strategies', {});
  const reopenedRows = (reopened.data as { strategies?: { id?: string }[] })?.strategies ?? [];
  if (!reopenedRows.some((row) => row.id === writtenStrategyId))
    throw new Error(`reopened deployment lost the written strategy: ${JSON.stringify(reopened)}`);
  await terminate(second);

  // 6) 回退演练：停新写入后，从切换前副本恢复并合并备份后新增事实，绝不覆盖新事实。
  const rollbackDir = join(root, 'rollback');
  mkdirSync(rollbackDir, { recursive: true });
  const rollbackDb = join(rollbackDir, 'luoome.db');
  copyFileSync(join(backupDir, 'pre-switch.db'), rollbackDb);
  const restored = sqliteTool().call(
    'report',
    rollbackDb,
    join(rollbackDir, 'unused.db'),
    join(root, 'rollback-before.json'),
  );
  if (restored.integrity !== 'ok' || restored.accounts !== 1 || restored.strategies !== 0)
    throw new Error(`rollback copy must be the pre-switch state: ${JSON.stringify(restored)}`);
  const reconciled = sqliteTool().call(
    'reconcile',
    join(backupDir, 'post-switch.db'),
    rollbackDb,
    join(root, 'rollback-after.json'),
  );
  if (
    reconciled.integrity !== 'ok' ||
    reconciled.accounts !== 1 ||
    reconciled.strategies !== 1 ||
    reconciled.mergedStrategies !== 1
  )
    throw new Error(`rollback reconcile failed: ${JSON.stringify(reconciled)}`);
  if (
    JSON.stringify(reconciled.accountsFingerprint) !== JSON.stringify(restored.accountsFingerprint)
  )
    throw new Error('rollback must not overwrite pre-switch account facts');
  const strategyIds = (reconciled.strategyIds as string[]) ?? [];
  if (!strategyIds.includes(writtenStrategyId))
    throw new Error('rollback must preserve the post-backup new fact');

  // 7) 默认部署静态检查：docker compose config 只有纯插件 Web + Caddy。
  const deployment = composeCheck();

  // 8) 产物检查：tarball/host bundle 无源码、无 MCP/Bun 运行依赖。
  const bundleText = readFileSync(hostBundle, 'utf8');
  const forbiddenArtifacts = ['bun:sqlite', '@luoome/mcp', 'LUOOME_MCP_', 'queue-probe'].filter(
    (needle) => bundleText.includes(needle),
  );
  if (forbiddenArtifacts.length > 0)
    throw new Error(
      `plugin bundle contains legacy runtime needles: ${forbiddenArtifacts.join(',')}`,
    );
  if (entries.some((entry) => entry.endsWith('.ts')))
    throw new Error('tarball must not contain TypeScript sources');

  Object.assign(summary, {
    mode: '隔离切换/回退演练（合成事实库；未启动模型；非真实生产切换）',
    runtime: {
      dshLaunchedWith: run('node', ['--version']).stdout.trim(),
      buildTool: run('bun', ['--version']).stdout.trim(),
      launchEnvMCPFree: true,
      launchEnvWorkerFree: true,
    },
    switch: {
      installStep: 'deploy/dsh/profile-seed.mjs（与 entrypoint 相同）',
      profile: seed,
      pluginProfile: {
        profile: pluginProfile.profile,
        accountId: pluginProfile.accountId,
        automationsEnabled: pluginProfile.automationsEnabled,
        readToolCount: (pluginProfile.readTools ?? []).length,
        policyCount: (pluginProfile.policies ?? []).length,
      },
      panels,
      skills: {
        expected: [...SKILL_NAMES],
        catalog: catalogSkills.map((skill) => skill.name),
        legacyAbsent: LEGACY_SKILL_NAMES,
      },
      readTool: {
        tool: 'list_accounts',
        via: 'host-authenticated /api/luoome/call',
        ...accountData,
      },
      approvedWrite: {
        tool: 'create_strategy',
        path: 'prepare → one-time confirmation token → confirm（production 操作表单路径）',
        nativeApproval:
          '模型侧 allowed-once 审批由 dsh-authority.e2e.test.ts / MVP journeys 覆盖，本演练不驱动模型',
        operationId,
        state: confirmedState,
        strategyId: writtenStrategyId,
        readableViaReadTool: true,
        genericCallWriteDeniedStatus: deniedWrite.status,
      },
      persistence: {
        dbPath: 'LUOOME_HOME/luoome.db',
        reopenedDshWeb: true,
        strategyStillReadable: true,
      },
      processes: {
        dshExit: firstExit,
        descendantCount: descendants.length,
        sawForbidden: forbidden,
        commands: descendants.map((entry) => entry.command.split(/\s+/).slice(0, 2).join(' ')),
        noMCP: true,
        noBunCLI: true,
        noLegacyBunWeb: true,
        noWorkerOrQueueProbe: true,
        oldOriginClosedAfterExit: firstOriginClosed,
      },
      artifact: {
        tarball: { name: tarballName, bytes: statSync(tarball).size, entries },
        hostBundleBytes: hostBundleSize,
        clientBundleBytes: clientBundleSize,
        clientBundleLimitBytes: CLIENT_BUNDLE_LIMIT_BYTES,
        forbiddenRuntimeNeedles: forbiddenArtifacts,
        tarballHasNoSources: true,
        marketToolCount: MARKET_TOOL_COUNT,
      },
    },
    backup: {
      semantics:
        'node:sqlite backup API（在线一致性快照）；只把快照主文件复制到独立目录验证自包含，不把活跃 WAL 主文件当完整备份',
      preSwitch: {
        path: 'backup/pre-switch.db',
        sha256: sha256(join(backupDir, 'pre-switch.db')),
        ...preSwitch,
      },
      postSwitchLive: {
        path: 'backup/post-switch.db',
        sha256: sha256(join(backupDir, 'post-switch.db')),
        takenWhileDshRunning: true,
        ...postSwitch,
      },
      standaloneRecovery: standalone,
    },
    rollback: {
      procedure: [
        '停止新写入（先停纯插件 Web，确认旧 origin 不可达）',
        '用切换前一致性副本恢复代码/profile 与事实库',
        '把备份后新增事实从切换后快照按业务键合并，不覆盖既有行',
      ],
      restoredPreSwitch: restored,
      reconciled: {
        strategies: reconciled.strategies,
        mergedStrategies: reconciled.mergedStrategies,
        accountsUnchanged: true,
        preservedNewFact: writtenStrategyId,
      },
      noNewFactOverwrite: true,
    },
    deployment,
    notes: [
      '这是隔离演练：合成账户/策略与临时 DSH_HOME/profile，不读写真实个人库、不联网供应商、不调用模型。',
      '面板 overview 的市场 external 工具在离线环境可能返回 error；只断言 ToolResult 形状与 owner 数据，不依赖真实供应商。',
      '未执行生产服务器切换；旧 MCP/Bun 入口源码保留（P5 再删）。',
    ],
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
        root,
      },
      null,
      2,
    ),
  );
  for (const [index, fixture] of launched.entries())
    console.error(
      `--- DSH launch ${String(index + 1)} output ---\n${fixture.output().replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>')}`,
    );
  console.error(`acceptance root kept for inspection: ${root}`);
  process.exitCode = 1;
} finally {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  if (process.env.KEEP !== '1' && process.exitCode !== 1)
    rmSync(root, { recursive: true, force: true });
}
