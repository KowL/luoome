// dsh-luoome 随包技能注册（需求 §8、插件详细设计 §8）。
//
// 四个 MVP 技能以 Markdown 随包分发（`packages/dsh-luoome/skills/<name>/SKILL.md`）。
// 插件 apply 时从包内目录读取并解析 frontmatter，通过 `ctx.skills.registerProvider()` 注册为
// 低优先级的 packaged/bundled 来源；用户自改技能（custom/user）与项目技能可以覆盖同名插件
// 技能。注册随插件 fiber 的 effect 一起撤销，插件 dispose 后旧 catalog 失效。
//
// 路径解析只用 `import.meta.url` 相对查找，不写死仓库/源码绝对路径：源码运行时
// (`src/host/skills.ts`) 与打包产物 (`dist/host.js`) 都向上找到包根 `skills/`。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillInvocationPolicy,
  type SkillProvider,
  type SkillProviderControl,
  type SkillSource,
} from '@deepseek-ai/dsh-skill';

/** 随包技能的唯一事实来源；注册和内容校验都以它为清单。 */
export const BUNDLED_SKILL_NAMES = [
  'daily-market-analysis',
  'post-close-review',
  'strategy-lab',
  'strategy-result-review',
] as const;

export type BundledSkillName = (typeof BUNDLED_SKILL_NAMES)[number];

/**
 * DSH 的 skill source 元数据。插件把技能按随包产物对待，因此使用 `bundled`。
 * 优先级由下面的 provider rank 决定，而不是 source 字符串。
 */
export const BUNDLED_SKILL_SOURCE: SkillSource = 'bundled';

/** provider 名与 candidate.provider 必须是同一个值（registry 会校验二者一致）。 */
export const BUNDLED_SKILL_PROVIDER = 'dsh-luoome';

/**
 * 插件技能的 provider 排序权重：DSH 标准 packaged/bundled rank（600，数值越小越优先）。
 *
 * 同名技能在同一 layer 内按 rank 选赢家，因此：
 * - project-dsh(100) / project-agents(200) / runtime(250) / custom(300) / user(400,500) 都优先于插件；
 * - 本地 bundled 文件根同为 600，按 provider 注册顺序决胜；DSH base 的 filesystem provider
 *   先于插件注册，所以本地随包技能也不会被插件覆盖。
 * 结论：插件只提供默认技能，用户自改技能始终可以覆盖同名条目。
 */
export const BUNDLED_SKILL_PRIORITY_RANK = BUNDLED_SKILL_RANK;

const BUNDLED_SKILL_INVOCATION: SkillInvocationPolicy = Object.freeze({
  modelInvocable: true,
  userInvocable: true,
});

/** 单文件上限：技能是受控 Markdown，异常超限说明打包或路径出了问题。 */
const MAX_SKILL_BYTES = 256 * 1024;
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** 注册只需要目标服务上的 registerProvider()；结构化类型便于用真实 registry 或替身测试。 */
export interface BundledSkillsService {
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void;
}

export interface BundledSkillsContext {
  readonly skills: BundledSkillsService;
}

export interface BundledSkillFile {
  readonly name: BundledSkillName;
  readonly description: string;
  readonly whenToUse: string;
  /** Markdown 正文（已去掉 frontmatter），与 filesystem provider 的 content 语义一致。 */
  readonly content: string;
  /** 磁盘上的 SKILL.md 绝对路径，仅作展示与诊断，不参与权限判断。 */
  readonly path: string;
}

/**
 * 从模块位置向上查找包根 `skills/`。
 *
 * 源码位于 `<pkg>/src/host/skills.ts`（需上跳两层），构建产物位于 `<pkg>/dist/host.js`
 * （上跳一层），安装后包根同样是 node_modules/dsh-luoome。找不到时直接抛错，不静默跳过。
 */
export const resolveBundledSkillsRoot = (moduleUrl: string): string => {
  let directory = dirname(fileURLToPath(moduleUrl));
  const tried: string[] = [];
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(directory, 'skills');
    tried.push(candidate);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`dsh-luoome 未找到随包 skills 目录；已尝试: ${tried.join(' | ')}`);
};

/**
 * 解析并严格校验一个技能文件。
 *
 * 只接受 name/description/whenToUse 三个字段（frontmatter 里的其它行按 YAML 注释/字段
 * 跳过），缺少任一必需字段、name 非法或与目录名不一致、正文为空都直接抛错。
 */
export const parseBundledSkillFile = (
  path: string,
  expectedName: BundledSkillName,
): BundledSkillFile => {
  const raw = readFileSync(path, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_BYTES)
    throw new Error(`技能文件超过大小上限 ${String(MAX_SKILL_BYTES)} 字节: ${path}`);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (frontmatter === null) throw new Error(`技能文件缺少 frontmatter: ${path}`);
  const fields = new Map<string, string>();
  for (const line of (frontmatter[1] ?? '').split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/.exec(line);
    if (pair === null) throw new Error(`技能 frontmatter 行无法解析 (${path}): ${line}`);
    fields.set(pair[1] as string, (pair[2] as string).trim());
  }
  const name = fields.get('name');
  const description = fields.get('description');
  const whenToUse = fields.get('whenToUse');
  if (name === undefined || description === undefined || whenToUse === undefined)
    throw new Error(`技能 frontmatter 必须包含 name/description/whenToUse: ${path}`);
  if (name !== expectedName)
    throw new Error(`技能 name 与目录名不一致 (${path}): name=${name} dir=${expectedName}`);
  if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`技能 name 不是 kebab-case: ${name}`);
  if (description === '') throw new Error(`技能 description 不能为空: ${path}`);
  const content = raw.slice(frontmatter[0].length).trim();
  if (content === '') throw new Error(`技能正文不能为空: ${path}`);
  return { name: expectedName, description, whenToUse, content, path };
};

/**
 * 读取并校验全部随包技能。目录缺失、预期技能缺失、出现未声明目录或任一文件损坏都抛错，
 * 让打包/安装错误在插件启动时暴露，而不是静默少注册几个技能。
 */
export const readBundledSkills = (
  root: string = resolveBundledSkillsRoot(import.meta.url),
): readonly BundledSkillFile[] => {
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`dsh-luoome 随包 skills 目录不存在: ${root}`);
  const directories = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const present = new Set(directories);
  const missing = BUNDLED_SKILL_NAMES.filter((name) => !present.has(name));
  if (missing.length > 0)
    throw new Error(`dsh-luoome 随包技能缺失 (${root}): ${missing.join(', ')}`);
  const known = new Set<string>(BUNDLED_SKILL_NAMES);
  const unexpected = directories.filter((name) => !known.has(name));
  if (unexpected.length > 0)
    throw new Error(`dsh-luoome 随包 skills 目录含未声明技能: ${unexpected.join(', ')}`);
  return BUNDLED_SKILL_NAMES.map((name) =>
    parseBundledSkillFile(join(root, name, 'SKILL.md'), name),
  );
};

/**
 * 构造读取内存解析结果的只读 provider：catalog 在装配时冻结，get() 不再读盘。
 * provider 名与 candidate.provider 必须一致（registry validateCandidate 会检查）。
 */
export const createBundledSkillProvider = (skills: readonly BundledSkillFile[]): SkillProvider => {
  const byName = new Map<string, BundledSkillFile>(skills.map((skill) => [skill.name, skill]));
  return {
    name: BUNDLED_SKILL_PROVIDER,
    list: async (options) => {
      options.signal?.throwIfAborted();
      const candidates: SkillCandidate[] = skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        invocation: BUNDLED_SKILL_INVOCATION,
        source: BUNDLED_SKILL_SOURCE,
        provider: BUNDLED_SKILL_PROVIDER,
        rank: BUNDLED_SKILL_PRIORITY_RANK,
        locator: { name: skill.name },
        path: skill.path,
      }));
      return candidates;
    },
    get: async (candidate, options) => {
      options.signal?.throwIfAborted();
      const skill = byName.get(candidate.name);
      if (skill === undefined) return undefined;
      const definition: SkillDefinition = {
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        invocation: BUNDLED_SKILL_INVOCATION,
        source: BUNDLED_SKILL_SOURCE,
        provider: BUNDLED_SKILL_PROVIDER,
        content: skill.content,
        path: skill.path,
      };
      return definition;
    },
  };
};

/**
 * 把四个随包技能注册进 DSH skill registry，返回幂等的整体 disposer。
 *
 * 使用 `ctx.skills.registerProvider()` 并提交 `BUNDLED_SKILL_PRIORITY_RANK`（600）：
 * 插件技能是 packaged/bundled 默认值，项目（100/200）、runtime（250）、custom（300）与
 * 用户（400/500）同名技能都按 DSH rank 语义胜出，因此不会覆盖用户自改技能。
 * DSH base 的本地 bundled 文件根同为 600，但先于插件注册，tie-break 也不会被插件抢走。
 *
 * provider 注册失败会包装成清晰错误再抛出；dispose 后重复调用无副作用。
 */
export const registerBundledSkills = (ctx: BundledSkillsContext, root?: string): (() => void) => {
  const service = ctx.skills;
  if (service === undefined || typeof service.registerProvider !== 'function')
    throw new Error(
      'dsh-luoome 插件需要 DSH skills 服务（registerProvider）；宿主未提供时拒绝装配',
    );
  const provider = createBundledSkillProvider(readBundledSkills(root));
  let dispose: () => void;
  try {
    dispose = service.registerProvider(() => provider);
  } catch (error) {
    throw new Error(
      `dsh-luoome 随包技能注册失败: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
};
