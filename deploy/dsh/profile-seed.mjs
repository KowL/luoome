// 纯插件默认部署的 DSH profile 装配：把已构建的 dsh-luoome 插件（host + client + skills）
// 安装进 `$DSH_HOME/profiles/<name>`，供 `dsh --profile <name>` 直接加载。
//
// 默认部署只使用 Node：本脚本是普通 ESM，不依赖 Bun、不启动 MCP/Bun CLI/worker。
// 重复执行幂等：插件产物与 profile 元数据按镜像版本覆盖，会话目录与业务事实库不动，
// 因此升级镜像后 entrypoint 重新执行本脚本即可完成插件更新。
//
// 用法:
//   node deploy/dsh/profile-seed.mjs --plugin /app/plugin/dsh-luoome.tgz [--profile luoome-web]
//     [--home <DSH_HOME>] [--modules <DSH 模块目录>]
//     [--pocket <已安装的 dsh-pocket 包目录>]
// 退出码 0 = 装配成功；非 0 = fail-closed（缺产物/缺 DSH 模块/缺技能都直接失败）。
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const PLUGIN_NAME = 'dsh-luoome';
const POCKET_NAME = 'dsh-pocket';
const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
const REQUIRED_SKILLS = [
  'daily-market-analysis',
  'post-close-review',
  'strategy-lab',
  'strategy-result-review',
];
const PLUGIN_ENTRY_FILES = ['dist/host.js', 'dist/client.js', 'package.json'];

const fail = (message) => {
  console.error(`[luoome-profile-seed] ${message}`);
  process.exit(1);
};

const parseArgs = (argv) => {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) fail(`unexpected argument: ${flag}`);
    const key = flag.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`missing value for ${flag}`);
    args[key] = value;
    index += 1;
  }
  return args;
};

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const scopePackageDirectories = (root) => {
  // npm 全局安装可能把 @deepseek-ai/* 平铺在全局根，也可能挂在 dsh 包自己的
  // node_modules 下；两种布局都要能发现，否则插件加载会缺 DSH SDK。
  const scopes = [
    join(root, '@deepseek-ai'),
    join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
  ];
  const packages = new Map();
  for (const scope of scopes) {
    if (!isDirectory(scope)) continue;
    for (const entry of readdirSync(scope)) {
      if (entry.startsWith('.')) continue;
      const directory = join(scope, entry);
      if (isDirectory(directory) && !packages.has(entry)) packages.set(entry, directory);
    }
  }
  return packages;
};

const resolveModulesRoot = (explicit) => {
  const candidates = [];
  if (explicit !== undefined) candidates.push(explicit);
  if (process.env.DSH_MODULES) candidates.push(process.env.DSH_MODULES);
  try {
    candidates.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch {
    // npm 不可用时仍可依赖显式 --modules/DSH_MODULES。
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const packages = scopePackageDirectories(resolve(candidate));
    if (packages.size > 0) return { root: resolve(candidate), packages };
  }
  return fail(
    'cannot find DSH @deepseek-ai modules; pass --modules or set DSH_MODULES to the global node_modules',
  );
};

const installPlugin = (pluginPath, profileModules) => {
  const stat = statSync(pluginPath);
  const installed = join(profileModules, PLUGIN_NAME);
  rmSync(installed, { recursive: true, force: true });
  if (stat.isDirectory()) {
    cpSync(pluginPath, installed, { recursive: true });
    return 'directory';
  }
  mkdirSync(installed, { recursive: true });
  execFileSync('tar', ['-xzf', resolve(pluginPath), '-C', installed, '--strip-components=1']);
  return 'tarball';
};

const assertPluginLayout = (installed) => {
  for (const file of PLUGIN_ENTRY_FILES)
    if (!existsSync(join(installed, file))) fail(`plugin artifact is missing ${file}`);
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  if (manifest.name !== PLUGIN_NAME) fail(`plugin artifact is ${String(manifest.name)}`);
  if (manifest.dsh?.client?.platform !== 'web')
    fail('plugin artifact must declare dsh.client.platform=web');
  for (const skill of REQUIRED_SKILLS)
    if (!existsSync(join(installed, 'skills', skill, 'SKILL.md')))
      fail(`plugin artifact is missing skills/${skill}/SKILL.md`);
  return { version: manifest.version, skills: REQUIRED_SKILLS };
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const pluginPath = args.plugin ?? process.env.DSH_PLUGIN_ARTIFACT;
  if (!pluginPath)
    fail('usage: node profile-seed.mjs --plugin <tarball|directory> [--profile name]');
  if (!existsSync(pluginPath)) fail(`plugin artifact does not exist: ${pluginPath}`);
  const profile = args.profile ?? process.env.DSH_PROFILE ?? 'luoome-web';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile)) fail(`invalid profile name: ${profile}`);
  const home = resolve(args.home ?? process.env.DSH_HOME ?? '/var/lib/dsh');
  const profileDir = join(home, 'profiles', profile);
  const profileModules = join(profileDir, 'node_modules');

  const modules = resolveModulesRoot(args.modules);
  mkdirSync(profileModules, { recursive: true });

  // DSH SDK 依赖按包逐个链接，避免不同 npm 布局下整目录软链失效。
  const scopeDirectory = join(profileModules, '@deepseek-ai');
  rmSync(scopeDirectory, { recursive: true, force: true });
  mkdirSync(scopeDirectory, { recursive: true });
  for (const [name, directory] of modules.packages)
    symlinkSync(directory, join(scopeDirectory, name), 'dir');

  const installedAs = installPlugin(pluginPath, profileModules);
  const installed = join(profileModules, PLUGIN_NAME);
  const artifact = assertPluginLayout(installed);
  const dependencies = {};
  const bundles = [...PROFILE_BUNDLES];
  if (args.pocket !== undefined) {
    const pocket = resolve(args.pocket);
    const manifest = JSON.parse(readFileSync(join(pocket, 'package.json'), 'utf8'));
    if (manifest.name !== POCKET_NAME || !manifest.dsh?.bundle?.patch)
      fail('pocket artifact must be the dsh-pocket bundle');
    const target = join(profileModules, POCKET_NAME);
    rmSync(target, { recursive: true, force: true });
    symlinkSync(pocket, target, 'dir');
    dependencies[POCKET_NAME] = `file:${pocket}`;
    bundles.push(POCKET_NAME);
  }

  const dependencyTarget =
    installedAs === 'tarball'
      ? `file:./${basename(pluginPath)}`
      : `file:./node_modules/${PLUGIN_NAME}`;
  if (installedAs === 'tarball')
    copyFileSync(resolve(pluginPath), join(profileDir, basename(pluginPath)));

  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${profile}`,
        private: true,
        type: 'module',
        dependencies: { [PLUGIN_NAME]: dependencyTarget, ...dependencies },
        dsh: { profile: { bundles } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');
  // profile 由镜像管理：插件层随镜像版本更新；会话与事实库不在此文件。
  // 但补丁层文件里还有 DSH 自己写入的 UI 设置（例如已读的欢迎提示版本），
  // 整份重写会把这些用户态设置抹掉，用户每次升级都要重新点一次「继续」。
  // 插件挂载已经正确时保留原文件，只在缺失或与镜像不符时重写。
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const existingPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  // DSH 自己写回的补丁层是 YAML（`- id: luoome-plugin` / `name: dsh-luoome`），
  // 只认 JSON 形态会永远判定未挂载，于是每次装配都整份重写，连同用户配置的
  // 模型 provider 与已读提示版本一起抹掉。这里两种形态都认。
  const normalizedPatch = existingPatch.replace(/["']/g, '').replace(/\s+/g, ' ');
  const pluginMounted =
    /(?:^|[\s{,])id:\s*luoome-plugin\b/.test(normalizedPatch) &&
    new RegExp(`(?:^|[\\s{,])name:\\s*${PLUGIN_NAME}\\b`).test(normalizedPatch);
  if (!pluginMounted)
    writeFileSync(
      patchPath,
      `${JSON.stringify([{ insert: [{ id: 'luoome-plugin', name: PLUGIN_NAME }] }], null, 2)}\n`,
    );

  const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: 'pure-plugin profile seed',
        profile,
        profileDir,
        plugin: {
          name: PLUGIN_NAME,
          version: artifact.version,
          installedAs,
          dependency: profileManifest.dependencies?.[PLUGIN_NAME],
          skills: artifact.skills,
        },
        modulesRoot: modules.root,
        linkedDshPackages: modules.packages.size,
        bundles,
      },
      null,
      2,
    ),
  );
};

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
