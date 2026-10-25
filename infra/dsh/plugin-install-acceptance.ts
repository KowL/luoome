// 隔离安装/加载验收：把 dsh-luoome 打成 tarball，在临时 DSH profile 中用 npm 安装插件与
// 固定版本的 DSH，用该独立安装的 CLI 加载生产 host，并验证 Node SQLite、只读/市场工具、原生确认
// policies、宿主认证路由与随包技能 catalog。
//
// 本节是「协议/装配验收」，不是真实模型质量验收：只调用宿主认证的只读 HTTP 路由、
// 一个 catalog/native-call probe 插件和一个临时 profile，不启动模型、不触碰真实个人库或真实供应商。
// 临时 DSH_HOME/profile 全部在 /tmp 下，结束（或 KEEP=1 时保留）清理。
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');
const packageDir = join(repo, 'packages/dsh-luoome');
const owner = Object.freeze({
  userId: 'plugin-acceptance-owner',
  accountId: 'plugin-acceptance-account',
});
const profileName = 'luoome-plugin';
const READ_TOOL_COUNT = 45;
const MARKET_TOOL_COUNT = 6;
const EXPECTED_MARKET_TOOLS = [
  'fetch_index_quotes',
  'get_ashare_sentiment',
  'fetch_quote',
  'batch_quote',
  'trial_strategy_version',
  'fetch_news',
] as const;
const SKILL_NAMES = [
  'daily-market-analysis',
  'post-close-review',
  'strategy-lab',
  'strategy-result-review',
] as const;
const LEGACY_SKILL_NAMES = [
  'analysis-worker',
  'stock-deep-dive',
  'morning-brief',
  'decision-journal',
  'luoome-batch',
] as const;
const PANEL_TOOL_NAMES = {
  overview: [
    'list_accounts',
    'list_holdings',
    'list_watch_triggers',
    'list_watchlists',
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

const FORBIDDEN_MARKET_TOOLS = [
  'send_notification',
  'sync_quotes',
  'record_advice',
  'add_trade',
  'get_stock_minute_bars',
  'import_remote_research_document',
  'fetch_sector_quotes',
] as const;

interface Descendant {
  readonly pid: number;
  readonly command: string;
}

const root = await mkdtemp(join(tmpdir(), 'luoome-plugin-install-'));
const workspace = join(root, 'workspace');
const profileDir = join(root, 'profiles', profileName);
const cli = join(profileDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const luoomeHome = join(root, 'luoome-home');
const children: ReturnType<typeof spawn>[] = [];
const launched: { output: () => string }[] = [];

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

const profile = async (origin: string, cookie: string, path: string, init: RequestInit = {}) => {
  if (process.env.ACCEPTANCE_TRACE === '1')
    console.error(`[trace] ${init.method ?? 'GET'} ${path.slice(0, 120)}`);
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      cookie,
      origin,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    redirect: 'manual',
  });
  return response;
};

const login = async (startup: string) => {
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
  for (let i = 0; i < 1500; i++) {
    const match = /dsh web: (\S+)/.exec(fixture.output());
    if (match?.[1] !== undefined) return match[1];
    if (fixture.child.exitCode !== null)
      throw new Error(`DSH web exited before ready:\n${fixture.output()}`);
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`DSH web did not become ready:\n${fixture.output()}`);
};

const waitForSkillsReport = async (path: string): Promise<Record<string, unknown>> => {
  for (let i = 0; i < 1500; i++) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    } catch {
      await new Promise((done) => setTimeout(done, 20));
    }
  }
  throw new Error(`skill catalog probe did not write ${path}`);
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
  for (const needle of ['luoome-mcp', 'mcp-server', 'analysis-worker', 'queue-probe', 'luoome/cli'])
    if (command.includes(needle)) return needle;
  return undefined;
};

const inspectTarball = (tarball: string): string[] =>
  run('tar', ['-tzf', tarball]).stdout.trim().split('\n');

const readApi = async (
  origin: string,
  cookie: string,
  tool: string,
  input: unknown,
): Promise<unknown> => {
  const response = await profile(origin, cookie, '/api/luoome/call', {
    method: 'POST',
    body: JSON.stringify({ tool, input }),
  });
  const value: unknown = await response.json();
  if (response.status !== 200)
    throw new Error(
      `/api/luoome/call ${tool} returned ${String(response.status)}: ${JSON.stringify(value)}`,
    );
  return value;
};

const apiProfile = async (origin: string, cookie: string): Promise<Record<string, unknown>> => {
  const response = await profile(origin, cookie, '/api/luoome/profile');
  if (response.status !== 200)
    throw new Error(
      `/api/luoome/profile returned ${String(response.status)}: ${await response.text()}`,
    );
  return (await response.json()) as Record<string, unknown>;
};

const callListAccounts = async (
  origin: string,
  cookie: string,
): Promise<{
  ok: boolean;
  total: number;
  accountId: string | null;
}> => {
  const value = (await readApi(origin, cookie, 'list_accounts', {})) as {
    ok?: boolean;
    data?: { total?: number; accounts?: { id?: string }[] };
    error?: unknown;
  };
  return {
    ok: value.ok === true,
    total: value.data?.total ?? -1,
    accountId: value.data?.accounts?.[0]?.id ?? null,
  };
};

const callHttp = async (
  origin: string,
  cookie: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; value: Record<string, unknown> }> => {
  const response = await profile(
    origin,
    cookie,
    path,
    body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) },
  );
  return { status: response.status, value: (await response.json()) as Record<string, unknown> };
};

interface DetectedSkill {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string | null;
  readonly source: string;
  readonly provider: string;
  readonly contentLength: number;
  readonly hasProcessSection: boolean;
}

/** 读技能 Markdown 的 frontmatter 字段，用来核对已安装文件与宿主 catalog 一致。 */
const readFrontmatterFields = (text: string): Map<string, string> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) throw new Error('installed skill is missing frontmatter');
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/.exec(line);
    if (pair?.[1] !== undefined && pair[2] !== undefined) fields.set(pair[1], pair[2].trim());
  }
  return fields;
};

const summary: Record<string, unknown> = {};
const redactDiagnostic = (text: string): string =>
  text.replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>');
try {
  await mkdir(workspace, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await mkdir(luoomeHome, { recursive: true });

  // 1) 构建生产插件产物（target=node, DSH SDK external）。
  run('bun', ['--no-env-file', 'run', 'build:dsh-luoome']);
  const hostBundle = join(packageDir, 'dist', 'host.js');
  const hostBundleSize = (await stat(hostBundle)).size;
  const clientBundle = join(packageDir, 'dist', 'client.js');
  const clientBundleSize = (await stat(clientBundle)).size;
  const clientBundleText = await readFile(clientBundle, 'utf8');
  if (clientBundleSize > CLIENT_BUNDLE_LIMIT_BYTES)
    throw new Error(
      `client bundle exceeds ${String(CLIENT_BUNDLE_LIMIT_BYTES)} bytes: ${String(clientBundleSize)}`,
    );
  if ((clientBundleText.match(/__ModuleLoader__\.load\(/g) ?? []).length !== 1)
    throw new Error('client bundle must register exactly one __ModuleLoader__ factory');
  if (!clientBundleText.includes('id:"dsh-luoome"'))
    throw new Error('client bundle must register the dsh-luoome client module id');
  if (!/require\("react("|\/jsx-runtime")?\)/.test(clientBundleText))
    throw new Error('client bundle must keep react external');
  if (
    /react\.development\.js|__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED/.test(
      clientBundleText,
    )
  )
    throw new Error('client bundle must not inline React internals');

  // 2) bun pm pack：验收包只包含 host/client、manifest 与四条技能。
  await rm(join(root, 'pack'), { recursive: true, force: true });
  await mkdir(join(root, 'pack'), { recursive: true });
  run('bun', ['pm', 'pack', '--destination', join(root, 'pack')], { cwd: packageDir });
  const packed = (await readdir(join(root, 'pack'))).filter((name) => name.endsWith('.tgz'));
  const tarballName = packed[0];
  if (tarballName === undefined) throw new Error('bun pm pack did not produce a tarball');
  const packedTarball = join(root, 'pack', tarballName);
  const entries = inspectTarball(packedTarball);
  const expectedSkillEntries = SKILL_NAMES.map((name) => `package/skills/${name}/SKILL.md`);
  const expectedEntries = [
    'package/dist/host.js',
    'package/dist/client.js',
    'package/package.json',
    ...expectedSkillEntries,
  ];
  // tar 可能带目录条目；只把文件条目计入精确清单。
  const fileEntries = entries.filter((entry) => !entry.endsWith('/'));
  if (
    fileEntries.length !== expectedEntries.length ||
    !expectedEntries.every((entry) => entries.includes(entry))
  )
    throw new Error(`unexpected tarball entries: ${JSON.stringify(entries)}`);

  // 3) 正常 npm 安装，不能靠解包或链接仓库依赖掩盖 tarball 的缺失/非法依赖。
  const sourceManifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
  };
  const dshVersion = sourceManifest.devDependencies['@deepseek-ai/dsh'];
  if (dshVersion === undefined) throw new Error('DSH install version is missing');
  await copyFile(packedTarball, join(profileDir, tarballName));
  await writeFile(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${profileName}`,
        private: true,
        type: 'module',
        dependencies: {
          '@deepseek-ai/dsh': dshVersion,
          'dsh-luoome': `file:./${tarballName}`,
        },
        dsh: {
          profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },
        },
      },
      null,
      2,
    )}\n`,
  );
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: profileDir,
  });
  const profileModules = join(profileDir, 'node_modules');
  const installedDir = join(profileModules, 'dsh-luoome');
  // M4：安装产物必须随包分发 client bundle，package.json 声明 dsh.client 与 ./client 导出。
  const installedManifest = JSON.parse(
    await readFile(join(installedDir, 'package.json'), 'utf8'),
  ) as {
    exports?: Record<string, unknown>;
    files?: string[];
    dsh?: { client?: { platform?: string; inject?: string[] } };
    dependencies: Record<string, string>;
  };
  for (const [name, version] of Object.entries(installedManifest.dependencies)) {
    if (!name.startsWith('@deepseek-ai/') || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
      throw new Error(`runtime dependency must be a pinned DSH package: ${name}@${version}`);
  }
  if (installedManifest.exports?.['./client'] !== './dist/client.js')
    throw new Error('installed package must export ./client -> ./dist/client.js');
  if (installedManifest.dsh?.client?.platform !== 'web')
    throw new Error('installed package must declare dsh.client.platform=web');
  if (
    !Array.isArray(installedManifest.dsh?.client?.inject) ||
    !installedManifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout') ||
    !installedManifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar')
  )
    throw new Error('installed package must inject layout/sidebar client modules');
  if (!installedManifest.files?.includes('dist/client.js'))
    throw new Error('installed package files must include dist/client.js');
  const installedClientText = await readFile(join(installedDir, 'dist', 'client.js'), 'utf8');
  if (installedClientText !== clientBundleText)
    throw new Error('installed client bundle must match the built dist/client.js');
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n');
  // 经过真实 Loader 创建活 Agent 并执行 native 工具，覆盖生产插件作用域的身份 guard；
  // HTTP /call 与根 Context 测试不会触发 Cordis 的 inject 检查。没有 Agent turn 或模型请求。
  const probePluginDir = join(profileModules, 'luoome-skills-probe');
  await mkdir(probePluginDir, { recursive: true });
  await writeFile(
    join(probePluginDir, 'package.json'),
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
  await writeFile(
    join(probePluginDir, 'index.js'),
    `import { writeFileSync } from 'node:fs';
export const name = 'luoome-skills-probe';
export const inject = ['skills', 'agents', 'tools'];
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
    for (const summary of catalog) {
      const definition = await ctx.skills.get(summary.name, {
        cwd: process.env.LUOOME_SKILLS_CWD,
      });
      skills.push({
        name: summary.name,
        description: summary.description,
        whenToUse: summary.whenToUse ?? null,
        source: summary.source,
        provider: summary.provider,
        contentLength: definition?.content.length ?? 0,
        hasProcessSection: definition?.content.includes('## 流程') ?? false,
      });
    }
    const missing = EXPECTED.filter((name) => !skills.some((skill) => skill.name === name));
    report.skills = skills;
    report.ok = missing.length === 0;
    report.error = missing.length === 0 ? null : 'missing: ' + missing.join(', ');
    const handle = await ctx.agents.create({
      sessionId: 'plugin-native-probe',
      agentOptions: { provider: 'no-model', model: 'no-model' },
      meta: { cwd: process.env.LUOOME_SKILLS_CWD },
    });
    try {
      const execute = (name, input) => ctx.tools.execute({
        name,
        arguments: input,
        callId: crypto.randomUUID(),
        agent: handle.agent,
        signal: new AbortController().signal,
      });
      report.nativeRead = await execute('list_accounts', {});
      if (report.nativeRead.isError || report.nativeRead.value?.ok !== true)
        throw new Error('native read failed: ' + JSON.stringify(report.nativeRead));
      report.nativeMarket = await execute('trial_strategy_version', {
        strategyId: 'missing-probe-strategy',
        baseVersionId: 'missing-base',
        draftVersionId: 'missing-draft',
        stockIds: ['600519.SH'],
      });
      if (report.nativeMarket.value?.error?.kind !== 'not_found')
        throw new Error('native market guard failed: ' + JSON.stringify(report.nativeMarket));
    } finally {
      await handle.dispose();
    }
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
  }
  writeFileSync(process.env.LUOOME_SKILLS_OUT, JSON.stringify(report));
};
`,
  );
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
        {
          insert: [
            { id: 'luoome-plugin', name: 'dsh-luoome' },
            { id: 'luoome-skills-probe', name: 'luoome-skills-probe' },
          ],
        },
      ],
      null,
      2,
    )}\n`,
  );

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

  // 4) 预置 owner 账户：用打包产物自身的 createProductionHost 建 schema（首次按设计
  //    因账户缺失拒绝），再用 node:sqlite 写入账户事实。此时不启动模型或供应商。
  const seedCode = `
const { createProductionHost } = await import(process.env.PLUGIN_HOST);
const { DatabaseSync } = await import('node:sqlite');
const home = process.env.LUOOME_HOME;
const owner = JSON.parse(process.env.PLUGIN_OWNER);
try {
  const host = await createProductionHost({ home, owner, env: { LUOOME_MARKET_PROVIDER: 'real' } });
  host.dispose();
  throw new Error('owner account unexpectedly existed');
} catch (error) {
  if (!/owner account does not exist/.test(String(error))) throw error;
}
const db = new DatabaseSync(home + '/luoome.db');
db.prepare('INSERT INTO accounts (id, name, kind, currency, initial_capital, cash_balance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(owner.accountId, 'Plugin acceptance', 'real', 'CNY', 1000000, 1000000, Date.now());
db.close();
process.stdout.write('seeded');
`;
  const seed = spawnSync('node', ['--input-type=module', '-e', seedCode], {
    env: {
      ...baseEnv,
      PLUGIN_HOST: join(installedDir, 'dist', 'host.js'),
      PLUGIN_OWNER: JSON.stringify(owner),
    },
    encoding: 'utf8',
  });
  if (seed.status !== 0) throw new Error(`owner seeding failed: ${seed.stderr || seed.stdout}`);
  const dbPath = join(luoomeHome, 'luoome.db');
  if ((await stat(dbPath)).size === 0)
    throw new Error('production host did not create the Node DB');

  // 4b) 用已安装 tarball 的 host 产物直接装配，验证 M2a market external 面确实随包分发：
  //     read 面不含 market 工具，market 面恰好默认 external 名单，且 HTTP /call 不暴露 market。
  const probeCode = `
const module = await import(process.env.PLUGIN_HOST);
const { createProductionHost, createProductionOperationPolicies, TRUSTED_ANALYSIS_PROVENANCE } = module;
const host = await createProductionHost({
  home: process.env.LUOOME_HOME,
  owner: JSON.parse(process.env.PLUGIN_OWNER),
  env: { LUOOME_MARKET_PROVIDER: 'real' },
});
const readTools = host.read.descriptors().map((tool) => tool.name);
const marketTools = host.market.descriptors().map((tool) => tool.name);
const marketConfig = host.config.market;
const policies = createProductionOperationPolicies().map((policy) => ({
  name: policy.tool.name,
  sideEffect: policy.tool.sideEffect,
  requiredCapabilities: policy.tool.requiredCapabilities,
  scheduled: policy.scheduled,
}));
host.dispose();
process.stdout.write(JSON.stringify({ readTools, marketTools, marketConfig, policies, trustedProvenance: TRUSTED_ANALYSIS_PROVENANCE }));
`;
  const probe = spawnSync('node', ['--input-type=module', '-e', probeCode], {
    env: {
      ...baseEnv,
      PLUGIN_HOST: join(installedDir, 'dist', 'host.js'),
      PLUGIN_OWNER: JSON.stringify(owner),
    },
    encoding: 'utf8',
  });
  if (probe.status !== 0) throw new Error(`installed artifact probe failed: ${probe.stderr}`);
  const installed = JSON.parse(probe.stdout) as {
    readTools: string[];
    marketTools: string[];
    marketConfig: {
      allowlist: string[];
      denylist: string[];
      timeoutMs: number;
      exposeResearch: boolean;
    };
    policies: {
      name: string;
      sideEffect: string;
      requiredCapabilities: string[];
      scheduled: boolean;
    }[];
    trustedProvenance: { generatorKind: string; model?: string; skillVersion?: string };
  };
  if (installed.readTools.length !== READ_TOOL_COUNT)
    throw new Error(`installed read surface has ${String(installed.readTools.length)} tools`);
  if (installed.marketTools.length !== MARKET_TOOL_COUNT)
    throw new Error(`installed market surface has ${String(installed.marketTools.length)} tools`);
  if ([...installed.marketTools].sort().join(',') !== [...EXPECTED_MARKET_TOOLS].sort().join(','))
    throw new Error(`installed market surface mismatch: ${JSON.stringify(installed.marketTools)}`);
  for (const name of EXPECTED_MARKET_TOOLS)
    if (installed.readTools.includes(name))
      throw new Error(`read surface must not contain market tool: ${name}`);
  for (const name of FORBIDDEN_MARKET_TOOLS)
    if (installed.marketTools.includes(name))
      throw new Error(`market surface must not expose: ${name}`);
  if (installed.marketConfig.timeoutMs !== 30_000)
    throw new Error(
      `market timeout must be 30000, received ${String(installed.marketConfig.timeoutMs)}`,
    );

  // 4c) M2b：安装产物必须携带精确写回 policies，且来源固定为受信任装配。
  const PRODUCTION_QUEUE_POLICIES = ['record_advice', 'record_analysis_result'] as const;
  const PRODUCTION_WRITE_POLICIES = [
    'save_decision_review',
    'create_strategy',
    'create_strategy_version',
    'validate_strategy_version',
    'publish_strategy_version',
    'record_advice_outcome',
  ] as const;
  const PRODUCTION_POLICY_NAMES = [
    ...PRODUCTION_QUEUE_POLICIES,
    ...PRODUCTION_WRITE_POLICIES,
  ].sort();
  const installedPolicyNames = installed.policies.map((policy) => policy.name).sort();
  if (
    installedPolicyNames.length !== PRODUCTION_POLICY_NAMES.length ||
    installedPolicyNames.join(',') !== PRODUCTION_POLICY_NAMES.join(',')
  )
    throw new Error(
      `installed operation policies mismatch: ${JSON.stringify(installedPolicyNames)}`,
    );
  const installedPolicies = new Map(installed.policies.map((policy) => [policy.name, policy]));
  for (const name of PRODUCTION_QUEUE_POLICIES) {
    const policy = installedPolicies.get(name);
    if (policy?.sideEffect !== 'queue' || policy.scheduled !== false)
      throw new Error(`installed ${name} policy must be an unscheduled queue policy`);
    if (JSON.stringify(policy.requiredCapabilities) !== JSON.stringify(['queue']))
      throw new Error(`installed ${name} policy capabilities mismatch`);
  }
  for (const name of PRODUCTION_WRITE_POLICIES) {
    const policy = installedPolicies.get(name);
    if (policy?.sideEffect !== 'write' || policy.scheduled !== false)
      throw new Error(`installed ${name} policy must be an unscheduled write policy`);
    if (JSON.stringify(policy.requiredCapabilities) !== JSON.stringify(['write']))
      throw new Error(`installed ${name} policy capabilities mismatch`);
  }
  for (const forbidden of [
    'claim_analysis_jobs',
    'complete_analysis_job',
    'fail_analysis_job',
    'requeue_analysis_job',
    'cancel_analysis_job',
    'get_analysis_metrics',
    'list_analysis_jobs',
    'get_analysis_job',
    'record_decision_trade',
    'add_trade',
    'send_notification',
    'delete_strategy',
    'pause_strategy',
    'resume_strategy',
    'archive_strategy',
    'set_strategy_schedule',
  ])
    if (installedPolicies.has(forbidden))
      throw new Error(`installed policies must not contain: ${forbidden}`);
  if (installed.trustedProvenance.generatorKind !== 'dsh-chat')
    throw new Error(
      `trusted provenance generatorKind mismatch: ${JSON.stringify(installed.trustedProvenance)}`,
    );
  if (
    installed.trustedProvenance.model !== undefined ||
    installed.trustedProvenance.skillVersion !== undefined
  )
    throw new Error('trusted provenance must keep unknown model/skillVersion unknown');

  // 5) 第一次启动：真实 DSH CLI 加载插件，走官方登录 + 只读 HTTP 路由。
  const first = launch(baseEnv);
  const firstStartup = await waitForReady(first);
  const firstOrigin = new URL(firstStartup).origin;
  const firstCookie = await login(firstStartup);
  const firstProfile = await apiProfile(firstOrigin, firstCookie);
  const firstCall = await callListAccounts(firstOrigin, firstCookie);

  // M4：真实 DSH Web 必须把 client bundle 编进 boot graph；宿主认证 state 路由返回真实
  // ToolResult（这里只验证协议/装配，不启动模型，也不宣称真实模型质量）。
  const shellResponse = await profile(firstOrigin, firstCookie, '/');
  if (shellResponse.status !== 200)
    throw new Error(`DSH shell returned ${String(shellResponse.status)}`);
  const shellHtml = await shellResponse.text();
  if (!shellHtml.includes('dsh-luoome'))
    throw new Error('DSH shell must reference the installed dsh-luoome client module');
  const comboMatch = /plugins\/[^"'\s<>]*dsh-luoome[^"'\s<>]*/.exec(shellHtml);
  if (comboMatch === null)
    throw new Error('DSH shell must load the dsh-luoome client bundle through /plugins');
  const comboPath = comboMatch[0].replaceAll('&amp;', '&');
  const servedClient = await profile(firstOrigin, firstCookie, `/${comboPath}`);
  if (servedClient.status !== 200)
    throw new Error(`served client bundle returned ${String(servedClient.status)}`);
  const servedClientText = await servedClient.text();
  if (!servedClientText.includes('__ModuleLoader__.load({id:"dsh-luoome"'))
    throw new Error('served client bundle must register the dsh-luoome module');
  if (!servedClientText.includes('看盘') || !servedClientText.includes('复盘'))
    throw new Error('served client bundle must contain the three panel entries');

  const stateResponse = async (panel: string) =>
    profile(firstOrigin, firstCookie, `/api/luoome/state?panel=${panel}`);
  const panelStates: Record<string, { status: number; toolNames: string[]; ok: boolean }> = {};
  for (const panel of ['overview', 'strategies', 'review'] as const) {
    const response = await stateResponse(panel);
    if (response.status !== 200)
      throw new Error(`/api/luoome/state?panel=${panel} returned ${String(response.status)}`);
    if (response.headers.get('cache-control') !== 'no-store')
      throw new Error('panel state route must be no-store');
    const body = (await response.json()) as {
      panel?: string;
      asOf?: string;
      tools?: { name?: string; ok?: boolean; data?: unknown; error?: unknown }[];
      strategies?: unknown[];
    };
    if (body.panel !== panel || typeof body.asOf !== 'string' || !Array.isArray(body.tools))
      throw new Error(`panel ${panel} state shape mismatch: ${JSON.stringify(body)}`);
    const toolNames = body.tools.map((tool) => String(tool.name));
    const expected = PANEL_TOOL_NAMES[panel];
    if (toolNames.length !== expected.length || !expected.every((name) => toolNames.includes(name)))
      throw new Error(
        `panel ${panel} tool mapping mismatch: ${JSON.stringify(toolNames)} != ${JSON.stringify(expected)}`,
      );
    for (const tool of body.tools) {
      if (typeof tool.ok !== 'boolean')
        throw new Error(`panel ${panel} tool ${String(tool.name)} missing ok flag`);
      if (tool.ok === true ? tool.data === undefined : tool.error === undefined)
        throw new Error(`panel ${panel} tool ${String(tool.name)} must project data or error`);
    }
    if (panel === 'overview') {
      const accounts = body.tools.find((tool) => tool.name === 'list_accounts');
      const data = accounts?.data as { total?: number; accounts?: { id?: string }[] } | undefined;
      if (accounts?.ok !== true || data?.total !== 1 || data.accounts?.[0]?.id !== owner.accountId)
        throw new Error(
          `panel overview list_accounts is not the real ToolResult: ${JSON.stringify(accounts)}`,
        );
    }
    if (panel === 'strategies' && !Array.isArray(body.strategies))
      throw new Error('strategies panel must expose per-strategy workspaces');
    panelStates[panel] = { status: response.status, toolNames, ok: true };
  }
  const deniedState = await fetch(`${firstOrigin}/api/luoome/state?panel=overview`, {
    redirect: 'manual',
  });
  if (deniedState.status !== 401)
    throw new Error(
      `unauthenticated state route must be 401, received ${String(deniedState.status)}`,
    );
  const unknownPanel = await stateResponse('admin');
  if (unknownPanel.status !== 404)
    throw new Error(`unknown panel must be 404, received ${String(unknownPanel.status)}`);
  // 405 语义由 packages/dsh-luoome/src/host/panels.test.ts 直接断言（handler 级
  // 405 + Allow: GET）。这里不再发 POST：宿主 carrier 对提前拒绝的 POST 会关闭未读入站流，
  // Bun fetch 会把该收尾视为 socket 关闭，属于传输层客户端差异，不代表路由语义。

  // M3b：随包技能必须进入真实 DSH skills catalog；描述与安装文件 frontmatter 一致，
  // 且不能出现旧 MCP 技能（临时工作区没有用户自定义技能，出现即说明打包/注册错误）。
  const skillsReport = await waitForSkillsReport(join(root, 'skills-catalog.json'));
  if (skillsReport.ok !== true)
    throw new Error(`skill catalog probe failed: ${JSON.stringify(skillsReport)}`);
  const catalogSkills = (
    Array.isArray(skillsReport.skills) ? skillsReport.skills : []
  ) as DetectedSkill[];
  for (const name of SKILL_NAMES) {
    const detected = catalogSkills.find((skill) => skill.name === name);
    if (detected === undefined) throw new Error(`skills catalog is missing ${name}`);
    const frontmatter = readFrontmatterFields(
      await readFile(join(installedDir, 'skills', name, 'SKILL.md'), 'utf8'),
    );
    if (detected.description !== frontmatter.get('description'))
      throw new Error(`skill ${name} description mismatch: ${JSON.stringify(detected)}`);
    if (detected.whenToUse !== frontmatter.get('whenToUse'))
      throw new Error(`skill ${name} whenToUse mismatch: ${JSON.stringify(detected)}`);
    if (detected.source !== 'bundled' || detected.provider !== 'dsh-luoome')
      throw new Error(
        `skill ${name} must be a bundled dsh-luoome skill: ${JSON.stringify(detected)}`,
      );
    if (!detected.hasProcessSection || detected.contentLength < 500)
      throw new Error(`skill ${name} content was not loaded: ${JSON.stringify(detected)}`);
  }
  for (const legacy of LEGACY_SKILL_NAMES)
    if (catalogSkills.some((skill) => skill.name === legacy))
      throw new Error(`skills catalog must not contain legacy skill ${legacy}`);
  if (catalogSkills.length !== SKILL_NAMES.length)
    throw new Error(
      `skills catalog must contain exactly the four bundled skills: ${JSON.stringify(
        catalogSkills.map((skill) => skill.name),
      )}`,
    );

  // M2b：有 policies 之后 generic `/call` 仍只读，写/市场/队列工具都按名拒绝。
  const callIsolation: { tool: string; status: number; errorKind: string | undefined }[] = [];
  for (const tool of [
    'fetch_quote',
    'record_advice',
    'record_analysis_result',
    'save_decision_review',
    'create_strategy',
    'create_strategy_version',
    'validate_strategy_version',
    'publish_strategy_version',
    'record_advice_outcome',
    'claim_analysis_jobs',
  ]) {
    const denied = await callHttp(firstOrigin, firstCookie, '/api/luoome/call', {
      tool,
      input: {},
    });
    callIsolation.push({
      tool,
      status: denied.status,
      errorKind: (denied.value as { error?: { kind?: string } }).error?.kind,
    });
  }

  // 未审批的 prepare 只能得到 pending operation，不产生任何业务写入；取消后仍无写入。
  const adviceCount = async (): Promise<number> => {
    const value = await readApi(firstOrigin, firstCookie, 'get_advice', {});
    return (value as { data?: { total?: number } }).data?.total ?? -1;
  };
  const prepared = await callHttp(firstOrigin, firstCookie, '/api/luoome/operations/prepare', {
    id: randomUUID(),
    tool: 'record_advice',
    input: {
      contextId: 'acceptance-context',
      result: {
        decision: 'watch',
        confidence: 55,
        horizon: 'short',
        reasoning: {
          premise: '验收占位结论',
          evidence: ['验收证据'],
          counterEvidence: ['验收反证'],
        },
        risks: ['验收风险'],
      },
      provenance: { generatorKind: 'legacy-ai', evidenceFactIds: [] },
    },
  });
  const preparedData = (prepared.value as { data?: Record<string, unknown> }).data ?? {};
  const preparedToken = preparedData.confirmationToken;
  if (
    prepared.status !== 200 ||
    preparedData.state !== 'pending' ||
    typeof preparedToken !== 'string'
  )
    throw new Error(
      `unapproved prepare must stay pending: ${String(prepared.status)} ${JSON.stringify(prepared.value)}`,
    );
  const pendingOperation = await callHttp(
    firstOrigin,
    firstCookie,
    `/api/luoome/operations/${String(preparedData.operationId ?? '')}`,
  );
  const pendingState = (pendingOperation.value as { data?: { state?: string; result?: unknown } })
    .data;
  if (pendingState?.state !== 'pending' || pendingState.result !== null)
    throw new Error(
      `prepared operation must have no business result: ${JSON.stringify(pendingState)}`,
    );
  const adviceCountBefore = await adviceCount();
  const cancelled = await callHttp(
    firstOrigin,
    firstCookie,
    `/api/luoome/operations/${String(preparedData.operationId ?? '')}/cancel`,
    { token: preparedToken },
  );
  if ((cancelled.value as { data?: { state?: string } }).data?.state !== 'cancelled')
    throw new Error(`unapproved operation cancel failed: ${JSON.stringify(cancelled.value)}`);
  const adviceCountAfter = await adviceCount();
  if (adviceCountBefore !== 0 || adviceCountAfter !== 0)
    throw new Error(
      `unapproved prepare must not write Advice: before=${String(adviceCountBefore)} after=${String(adviceCountAfter)}`,
    );

  const marketIsolation = callIsolation.find((entry) => entry.tool === 'fetch_quote');
  const descendants = descendantsOf(first.child.pid ?? -1);
  const forbidden = descendants.flatMap((process) => {
    const reason = forbiddenProcess(process.command);
    return reason === undefined ? [] : [{ ...process, reason }];
  });
  const firstExit = await terminate(first);
  const firstOriginClosed = await fetch(`${firstOrigin}/api/luoome/profile`).then(
    () => false,
    () => true,
  );

  // 6) 重启后数据仍在，且同样的宿主认证路由仍可读。
  const second = launch(baseEnv);
  const secondStartup = await waitForReady(second);
  const secondOrigin = new URL(secondStartup).origin;
  const secondCookie = await login(secondStartup);
  const secondProfile = await apiProfile(secondOrigin, secondCookie);
  const secondCall = await callListAccounts(secondOrigin, secondCookie);
  await terminate(second);

  if (!firstOriginClosed)
    throw new Error('old HTTP origin stayed reachable after plugin process exit');
  const readTools: string[] = Array.isArray(firstProfile.readTools)
    ? (firstProfile.readTools as string[])
    : [];
  const policies: unknown[] = Array.isArray(firstProfile.policies)
    ? (firstProfile.policies as unknown[])
    : [];
  if (firstProfile.accountId !== owner.accountId)
    throw new Error(`profile account mismatch: ${JSON.stringify(firstProfile.accountId)}`);
  if (firstProfile.automationsEnabled !== false)
    throw new Error('automationsEnabled must be false');
  const profilePolicyNames = policies
    .map((policy) => (policy as { name?: string }).name ?? '')
    .sort();
  if (profilePolicyNames.join(',') !== installedPolicyNames.join(','))
    throw new Error(
      `profile policies must match installed production policies: ${JSON.stringify(profilePolicyNames)}`,
    );
  for (const isolation of callIsolation)
    if (isolation.status !== 403 || isolation.errorKind !== 'permission_denied')
      throw new Error(
        `generic /call must reject ${isolation.tool}: ${String(isolation.status)} ${String(isolation.errorKind)}`,
      );
  if (readTools.length !== READ_TOOL_COUNT)
    throw new Error(
      `expected ${String(READ_TOOL_COUNT)} read tools, received ${String(readTools.length)}`,
    );
  if (!readTools.includes('list_accounts')) throw new Error('list_accounts is not registered');
  if (!firstCall.ok || firstCall.total !== 1 || firstCall.accountId !== owner.accountId)
    throw new Error(`first list_accounts failed: ${JSON.stringify(firstCall)}`);

  if (!secondCall.ok || secondCall.total !== 1 || secondCall.accountId !== owner.accountId)
    throw new Error(`reopened list_accounts failed: ${JSON.stringify(secondCall)}`);
  if (forbidden.length > 0)
    throw new Error(`forbidden child processes: ${JSON.stringify(forbidden)}`);
  if (JSON.stringify(firstProfile.readTools) !== JSON.stringify(secondProfile.readTools))
    throw new Error('read tool registration changed across restart');

  const bundleText = await readFile(hostBundle, 'utf8');
  const tarballText = await readFile(packedTarball, 'utf8');
  const forbiddenArtifacts = [
    'bun:sqlite',
    '@luoome/mcp',
    'packages/db/src',
    'packages/tools/src',
    'packages/dsh-luoome/src',
  ].filter(
    (needle) => bundleText.includes(needle) || entries.some((entry) => entry.includes(needle)),
  );
  const repoPathLeak = /\/Users\/|\/home\/[^/]+\/project\//.test(bundleText);

  Object.assign(summary, {
    mode: '协议/装配验收，非真实模型质量',
    dshLaunchedWithNode: run('node', ['--version']).stdout.trim(),
    bundleBuiltWithBun: run('bun', ['--version']).stdout.trim(),
    dshExit: firstExit,
    hostBundle: { path: 'packages/dsh-luoome/dist/host.js', bytes: hostBundleSize },
    client: {
      path: 'packages/dsh-luoome/dist/client.js',
      bytes: clientBundleSize,
      limitBytes: CLIENT_BUNDLE_LIMIT_BYTES,
      loaderWrapped: true,
      reactExternal: true,
      installedInTarball: entries.includes('package/dist/client.js'),
      servedThroughBootGraph: true,
      servedBytes: Buffer.byteLength(servedClientText),
      panelEntries: ['luoome-overview', 'luoome-strategies', 'luoome-review'],
    },
    stateRoute: {
      path: '/api/luoome/state?panel=overview|strategies|review',
      panels: panelStates,
      noStore: true,
      unauthenticatedStatus: deniedState.status,
      unknownPanelStatus: unknownPanel.status,
      methodSemantics: '405 + Allow: GET asserted in panels.test.ts (handler level)',
      ownerAccountMatched: true,
    },
    tarball: {
      name: tarballName,
      bytes: (await stat(packedTarball)).size,
      entries,
      runtimeDependencies: installedManifest.dependencies,
      installedWith: 'npm install --omit=dev --ignore-scripts --no-audit --no-fund',
      dshVersion,
    },
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      installedAs: 'profiles/<temp>/node_modules/dsh-luoome (local tarball)',
      activated: true,
      accountId: firstProfile.accountId,
      automationsEnabled: firstProfile.automationsEnabled,
      policies,
      policyNames: profilePolicyNames,
      readToolCount: readTools.length,
      readToolsSample: readTools.slice(0, 5),
      marketToolCount: installed.marketTools.length,
      marketTools: installed.marketTools,
      marketConfig: installed.marketConfig,
      marketForbiddenAbsent: FORBIDDEN_MARKET_TOOLS.every(
        (name) => !installed.marketTools.includes(name),
      ),
    },
    skills: {
      via: 'real DSH ctx.skills catalog (profile probe plugin)',
      expected: [...SKILL_NAMES],
      catalog: catalogSkills,
      legacyAbsent: [...LEGACY_SKILL_NAMES],
      tarballSkillEntries: expectedSkillEntries,
    },
    nativeCalls: {
      via: 'installed plugin Loader scope + live Agent + ToolRuntime.execute (no model turn)',
      read: skillsReport.nativeRead,
      market: skillsReport.nativeMarket,
    },
    toolCall: {
      tool: 'list_accounts',
      via: 'host-authenticated POST /api/luoome/call',
      ...firstCall,
    },
    callIsolation: {
      via: 'host-authenticated POST /api/luoome/call',
      tools: callIsolation,
      marketIsolation,
    },
    prepareWithoutApproval: {
      tool: 'record_advice',
      state: preparedData.state,
      result: null,
      cancelled: true,
      adviceCountBefore,
      adviceCountAfter,
    },
    persistence: { dbPath: 'LUOOME_HOME/luoome.db', reopened: true, ...secondCall },
    childProcesses: {
      descendantCount: descendants.length,
      sawForbidden: forbidden,
      commands: descendants.map((process) => process.command.split(/\s+/).slice(0, 2).join(' ')),
      noMCP: !descendants.some((process) => forbiddenProcess(process.command) !== undefined),
      noBunCLI: !descendants.some((process) => /(^|\/)(bun)(\s|$)/.test(process.command)),
      noWorkerOrProbe: !descendants.some((process) =>
        /analysis-worker|queue-probe|luoome\/cli/.test(process.command),
      ),
      oldOriginClosedAfterExit: firstOriginClosed,
    },
    artifactChecks: {
      forbiddenNeedles: forbiddenArtifacts,
      repoPathLeak,
      tarballHasNoSource: !entries.some((entry) => entry.endsWith('.ts')),
      tarballSizeBytes: (await stat(packedTarball)).size,
      tarballTextScanned: tarballText.length > 0,
    },
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(
    redactDiagnostic(
      JSON.stringify(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : null,
          root,
        },
        null,
        2,
      ),
    ),
  );
  for (const [index, fixture] of launched.entries())
    console.error(
      `--- DSH launch ${String(index + 1)} output ---\n${redactDiagnostic(fixture.output())}`,
    );
  console.error(`acceptance root kept for inspection: ${root}`);
  process.exitCode = 1;
} finally {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  if (process.env.KEEP !== '1' && process.exitCode !== 1)
    await rm(root, { recursive: true, force: true });
}
