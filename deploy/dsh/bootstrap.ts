/**
 * 独立 DSH 的 profile 装配。
 *
 * 每个 DSH profile = 一层 bundle 补丁 + 我们自己的用户补丁层：
 * bundle 决定「跑哪个前端/运行器」，用户补丁层只挂 MCP 实例与纪律插件。
 * 读面实例（luoome-web）与消费者实例（luoome-worker）是两个独立进程，
 * 各自连接同一个单机事实库，靠队列租约实现先到先得（设计文档 §5.4.4）。
 */
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type StandaloneRole,
  standaloneProfilePatch,
} from '../../packages/dsh-bridge/src/standalone-profile.js';
import { QUEUE_TOOL_NAMES } from '../../packages/tools/src/queue/names.js';
import { BATCH_TOOL_NAMES } from './batch-tools.js';
import { SETTINGS_TOOL_NAMES } from './settings-tools.js';

const DSH_VERSION = '0.2.1-rc.2';

const PROFILES: Record<
  StandaloneRole,
  { readonly profile: string; readonly bundles: readonly string[] }
> = {
  read: { profile: 'luoome-web', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },
  worker: {
    profile: 'luoome-worker',
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  },
};

const dshHome = process.env.DSH_HOME ?? '/var/lib/dsh';
const workspace = process.env.DSH_WORKSPACE ?? '/workspace';
const repoRoot = resolve(import.meta.dir, '../..');
/** 消费者的一次性会话单独放，不混进 GUI 侧栏的会话根目录。 */
const workerSessionRoot = join(dshHome, 'worker-sessions');

/**
 * 解析传给 luoome 业务进程的环境变量。
 * 格式：分号分隔的 k=v；用分号而不是逗号，是因为值本身可能是逗号分隔的列表
 * （例如 LUOOME_STOCK_UNIVERSE_SOURCES=eastmoney,sina）。
 */
const parseEnv = (value: string | undefined): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const pair of (value ?? '').split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) throw new Error(`invalid LUOOME_MCP_ENV entry: ${trimmed}`);
    result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return result;
};

/**
 * 写 profile 的入参按角色区分。
 *
 * 读面必须给设置面白名单、消费者必须给队列白名单：漏传就编译不过，
 * 不会像之前那样被对象展开静默丢掉，装出一个没有设置实例的 profile。
 */
type WriteProfileOptions = {
  readonly luoomeCommand: string;
  readonly luoomeArgs: readonly string[];
  readonly luoomeCwd: string;
  readonly luoomeHome: string;
  readonly luoomeEnv: Readonly<Record<string, string>>;
} & (
  | {
      readonly role: 'read';
      readonly settingsToolAllowlist: readonly string[];
      readonly batchToolAllowlist: readonly string[];
    }
  | { readonly role: 'worker'; readonly workerToolAllowlist: readonly string[] }
);

const writeProfile = async (options: WriteProfileOptions): Promise<string> => {
  const { role } = options;
  const { profile, bundles } = PROFILES[role];
  const dir = join(dshHome, 'profiles', profile);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const pluginPath = join(dir, 'luoome-discipline.js');
  await cp(join(repoRoot, 'packages/dsh-bridge/dist/standalone-prompt.js'), pluginPath);

  const patch = standaloneProfilePatch({
    role,
    luoomeCommand: options.luoomeCommand,
    luoomeArgs: options.luoomeArgs,
    luoomeCwd: options.luoomeCwd,
    luoomeHome: options.luoomeHome,
    luoomeEnv: options.luoomeEnv,
    disciplinePluginPath: pluginPath,
    ...(role === 'read'
      ? {
          panelsPluginPath: join(repoRoot, 'packages/dsh-bridge/dist/panels/standalone-panels.js'),
          settingsToolAllowlist: options.settingsToolAllowlist,
          batchToolAllowlist: options.batchToolAllowlist,
        }
      : {
          workerToolAllowlist: options.workerToolAllowlist,
          workerSessionRoot: workerSessionRoot,
        }),
  });

  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${profile}`,
        private: true,
        type: 'module',
        dependencies: {},
        dsh: { profile: { bundles: [...bundles] } },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(dir, 'cordis.yml'), '[]\n', { mode: 0o600 });
  await writeFile(
    join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    { mode: 0o600 },
  );
  // JSON 是合法 YAML；补丁层格式与 DSH 自带模板一致。
  await writeFile(join(dir, 'cordis.patch.yml'), `${JSON.stringify(patch, null, 2)}\n`, {
    mode: 0o600,
  });
  return profile;
};

const installSkills = async (): Promise<number> => {
  const target = join(workspace, '.dsh', 'skills');
  await mkdir(target, { recursive: true, mode: 0o700 });
  await cp(join(repoRoot, '.dsh', 'skills'), target, { recursive: true });
  const { readdir } = await import('node:fs/promises');
  return (await readdir(target, { withFileTypes: true })).filter((e) => e.isDirectory()).length;
};

const role = (process.argv[2] ?? 'web') === 'worker' ? 'worker' : 'read';
const luoomeCommand = process.env.LUOOME_MCP_COMMAND ?? 'bun';
const luoomeArgs = (
  process.env.LUOOME_MCP_ARGS ?? '--no-env-file,packages/cli/src/index.ts,mcp,serve'
).split(',');
const luoomeCwd = process.env.LUOOME_MCP_CWD ?? repoRoot;
const luoomeHome = process.env.LUOOME_HOME ?? '/var/lib/luoome';

const profile = await writeProfile(
  role === 'worker'
    ? {
        role: 'worker',
        luoomeCommand,
        luoomeArgs,
        luoomeCwd,
        luoomeHome,
        luoomeEnv: parseEnv(process.env.LUOOME_MCP_ENV),
        workerToolAllowlist: QUEUE_TOOL_NAMES,
      }
    : {
        role: 'read',
        luoomeCommand,
        luoomeArgs,
        luoomeCwd,
        luoomeHome,
        luoomeEnv: parseEnv(process.env.LUOOME_MCP_ENV),
        settingsToolAllowlist: [...SETTINGS_TOOL_NAMES],
        batchToolAllowlist: [...BATCH_TOOL_NAMES],
      },
);
const skillCount = await installSkills();
console.log(
  JSON.stringify({
    profile,
    role,
    skills: skillCount,
    dshVersion: DSH_VERSION,
    dshHome,
    workspace,
  }),
);
