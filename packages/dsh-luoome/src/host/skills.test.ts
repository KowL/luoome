// dsh-luoome 随包技能注册测试（需求 §8；task-16 验收）。
//
// 用真实的 DSH SkillRegistry（`@deepseek-ai/dsh-skill` + cordis Context）验证：
// - 四个 SKILL.md 从包内目录解析成功，frontmatter 与目录名一致；
// - 注册后 catalog 含四个技能，provider/source/content 正确；
// - dispose 撤销注册、重复 dispose 幂等、重复注册不泄漏；
// - 更高优先级的 project provider 同名技能不被覆盖；
// - 目录缺失 / frontmatter 损坏 / 缺 SKILL.md 时 fail-loud；
// - 打包清单（`bun pm pack --dry-run`）包含 skills/**/SKILL.md 且不含源码。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Context } from '@deepseek-ai/cordis';
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillProvider,
  SkillRegistry,
} from '@deepseek-ai/dsh-skill';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_SKILL_NAMES,
  BUNDLED_SKILL_PRIORITY_RANK,
  type BundledSkillsContext,
  createBundledSkillProvider,
  parseBundledSkillFile,
  readBundledSkills,
  registerBundledSkills,
  resolveBundledSkillsRoot,
} from './skills.js';

const packageDir = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
const skillsRoot = resolveBundledSkillsRoot(import.meta.url);
const roots: string[] = [];

const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'luoome-skills-'));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Service 随所属 fiber 自动卸载；测试里每个用例新建独立 Context + registry 即可。
const createRegistry = (): Context => {
  const ctx = new Context();
  new SkillRegistry(ctx);
  return ctx;
};

interface FakeProviderInput {
  readonly provider: string;
  readonly rank: number;
  readonly source: string;
  readonly name: string;
  readonly description?: string;
}

/** 注册一个只含单个技能的替身 provider，用于验证 rank 与同名覆盖语义。 */
const registerFakeSkillProvider = (ctx: Context, input: FakeProviderInput): void => {
  const invocation = { modelInvocable: true, userInvocable: true } as const;
  const description = input.description ?? `${input.provider} 的技能`;
  ctx.skills.registerProvider(
    (): SkillProvider => ({
      name: input.provider,
      list: async () => [
        {
          name: input.name,
          description,
          whenToUse: '替身触发条件',
          invocation,
          source: input.source,
          provider: input.provider,
          rank: input.rank,
          locator: { name: input.name },
        },
      ],
      get: async () => ({
        name: input.name,
        description,
        whenToUse: '替身触发条件',
        invocation,
        source: input.source,
        provider: input.provider,
        content: `# ${input.provider}\n`,
      }),
    }),
  );
};

describe('dsh-luoome 随包技能文件', () => {
  it('解析四个技能，frontmatter 与目录名一致，正文是 Markdown', () => {
    const skills = readBundledSkills();
    expect(skills.map((skill) => skill.name)).toEqual([...BUNDLED_SKILL_NAMES]);
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(10);
      expect(skill.whenToUse.length).toBeGreaterThan(5);
      expect(skill.content).toContain('本技能版本：');
      expect(skill.content).toContain('## 流程');
      expect(skill.content.startsWith('---')).toBe(false);
      expect(skill.path).toBe(join(skillsRoot, skill.name, 'SKILL.md'));
    }
  });

  it('按 dist 布局（包根/dist/host.js）也能找到包内 skills', () => {
    const root = tempRoot();
    const pkg = join(root, 'pkg');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    mkdirSync(join(pkg, 'skills'), { recursive: true });
    writeFileSync(join(pkg, 'dist', 'host.js'), '');
    expect(resolveBundledSkillsRoot(pathToFileURL(join(pkg, 'dist', 'host.js')).href)).toBe(
      join(pkg, 'skills'),
    );
  });

  it('坏 frontmatter / 缺文件 / 缺目录都 fail-loud', () => {
    const missingRoot = tempRoot();
    expect(() => readBundledSkills(missingRoot)).toThrow(/随包技能缺失/);

    const partialRoot = tempRoot();
    for (const name of BUNDLED_SKILL_NAMES) mkdirSync(join(partialRoot, name), { recursive: true });
    expect(() => readBundledSkills(partialRoot)).toThrow();

    const badFile = join(tempRoot(), 'SKILL.md');
    writeFileSync(badFile, '---\nname: Not_Kebab\ndescription: 缺 whenToUse\n---\n\n# body\n');
    expect(() => parseBundledSkillFile(badFile, 'strategy-lab')).toThrow(
      /name\/description\/whenToUse/,
    );
    writeFileSync(
      badFile,
      '---\nname: strategy-lab\ndescription: 有描述\nwhenToUse: 有触发\n---\n',
    );
    expect(() => parseBundledSkillFile(badFile, 'strategy-lab')).toThrow(/正文不能为空/);
    writeFileSync(badFile, '# 没有 frontmatter\n');
    expect(() => parseBundledSkillFile(badFile, 'strategy-lab')).toThrow(/缺少 frontmatter/);
  });
});

describe('dsh-luoome 技能注册', () => {
  it('provider candidate 使用 packaged rank 600 与 bundled/dsh-luoome 标识', async () => {
    expect(BUNDLED_SKILL_PRIORITY_RANK).toBe(BUNDLED_SKILL_RANK);
    const provider = createBundledSkillProvider(readBundledSkills());
    expect(provider.name).toBe('dsh-luoome');
    const listed = await provider.list({});
    const candidates = Array.isArray(listed) ? listed : [];
    expect(candidates).toHaveLength(BUNDLED_SKILL_NAMES.length);
    for (const candidate of candidates) {
      expect(candidate.rank).toBe(BUNDLED_SKILL_RANK);
      // 用户/custom 的 rank 更低（300–500），本地 project 更低（100/200）：插件必须让位。
      expect(candidate.rank).toBeGreaterThan(500);
      expect(candidate.source).toBe('bundled');
      expect(candidate.provider).toBe('dsh-luoome');
    }
    const first = candidates[0] as SkillCandidate | undefined;
    expect(first).toBeDefined();
    const definition = await provider.get(first as SkillCandidate, {});
    expect(definition?.content).toContain('## 流程');
  });

  it('注册后 catalog 与 get 都包含四个技能，provider/source 正确', async () => {
    const ctx = createRegistry();
    const dispose = registerBundledSkills(ctx);
    try {
      const catalog = await ctx.skills.list();
      const byName = new Map(catalog.map((skill) => [skill.name, skill]));
      for (const name of BUNDLED_SKILL_NAMES) {
        const summary = byName.get(name);
        expect(summary, `/skills 缺少 ${name}`).toBeDefined();
        expect(summary?.source).toBe('bundled');
        expect(summary?.provider).toBe('dsh-luoome');
        expect(summary?.description.length).toBeGreaterThan(10);
        expect(summary?.whenToUse).toBeDefined();
        const definition = await ctx.skills.get(name);
        expect(definition?.content).toContain('## 流程');
        expect(definition?.content).not.toContain('whenToUse:');
      }
    } finally {
      dispose();
    }
  });

  it('dispose 撤销 provider；重复 dispose 幂等、dispose 后可重新注册', async () => {
    const ctx = createRegistry();
    const first = registerBundledSkills(ctx);
    expect((await ctx.skills.list()).length).toBe(BUNDLED_SKILL_NAMES.length);

    // 已注册时再次注册同一 provider 会 fail-loud，而不是静默产生第二份 catalog。
    expect(() => registerBundledSkills(ctx)).toThrow(/随包技能注册失败/);

    first();
    first();
    expect(await ctx.skills.list()).toEqual([]);

    // dispose 之后可以重新注册（插件重复 apply 的等价路径）。
    const again = registerBundledSkills(ctx);
    expect((await ctx.skills.list()).length).toBe(BUNDLED_SKILL_NAMES.length);
    again();
    again();
    expect(await ctx.skills.list()).toEqual([]);
  });

  it('用户/custom/bundled 文件与 project 技能同名时优先于插件技能', async () => {
    const ctx = createRegistry();
    // 依次模拟 project-dsh(100)、custom(300)、user-dsh(400)、本地 bundled 文件根(600)。
    // bundled 与插件同为 600：本地文件 provider 先注册，tie-break 按 providerOrder 胜出。
    const fakeProviders = [
      { provider: 'fake-project', rank: 100, source: 'project-dsh', name: 'strategy-lab' },
      { provider: 'fake-custom', rank: 300, source: 'custom', name: 'strategy-result-review' },
      { provider: 'fake-user', rank: 400, source: 'user-dsh', name: 'post-close-review' },
      { provider: 'fake-bundled', rank: 600, source: 'bundled', name: 'daily-market-analysis' },
    ] as const;
    for (const fake of fakeProviders) registerFakeSkillProvider(ctx, fake);
    const dispose = registerBundledSkills(ctx);
    try {
      const catalog = await ctx.skills.list();
      for (const fake of fakeProviders) {
        const winner = catalog.find((skill) => skill.name === fake.name);
        expect(winner?.provider, `${fake.name} 应被 ${fake.provider} 覆盖`).toBe(fake.provider);
        expect(winner?.source).toBe(fake.source);
        expect(winner?.description).toBe(`${fake.provider} 的技能`);
      }
      // 四个同名条目全部由更高优先级来源胜出；插件技能不覆盖它们。
      expect(catalog.filter((skill) => skill.provider === 'dsh-luoome')).toHaveLength(0);
      const definition = await ctx.skills.get(fakeProviders[0].name);
      expect(definition?.content).toBe('# fake-project\n');
    } finally {
      dispose();
    }

    // 插件撤销后，用户技能保持原样（说明插件没有替换/删除别人的条目）。
    const afterDispose = await ctx.skills.list();
    for (const fake of fakeProviders)
      expect(afterDispose.find((skill) => skill.name === fake.name)?.provider).toBe(fake.provider);
    expect(afterDispose.filter((skill) => skill.provider === 'dsh-luoome')).toHaveLength(0);
  });

  it('无同名技能时四个插件技能全部可见且 source/provider 正确', async () => {
    const ctx = createRegistry();
    const dispose = registerBundledSkills(ctx);
    try {
      const catalog = await ctx.skills.list();
      expect(catalog).toHaveLength(BUNDLED_SKILL_NAMES.length);
      for (const summary of catalog) {
        expect(summary.provider).toBe('dsh-luoome');
        expect(summary.source).toBe('bundled');
      }
    } finally {
      dispose();
    }
  });

  it('provider 注册失败时包装成清晰错误（fail-loud）', () => {
    expect(() =>
      registerBundledSkills({
        skills: {
          registerProvider: () => {
            throw new Error('duplicate provider');
          },
        },
      }),
    ).toThrow(/随包技能注册失败: duplicate provider/);
  });

  it('缺少 skills 服务时拒绝装配（fail-loud）', () => {
    expect(() => registerBundledSkills({} as unknown as BundledSkillsContext)).toThrow(
      /skills 服务/,
    );
  });
});

describe('dsh-luoome 打包内容', () => {
  it('package.json files 包含 skills，bun pm pack 清单含四个 SKILL.md 且不含源码', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    expect(manifest.files).toContain('skills');

    const packed = spawnSync('bun', ['pm', 'pack', '--dry-run', '--ignore-scripts'], {
      cwd: packageDir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(packed.status, packed.stderr).toBe(0);
    const entries = [...packed.stdout.matchAll(/^packed\s+\S+\s+(.+)$/gm)].map(
      (match) => match[1] as string,
    );
    expect(entries).toContain('package.json');
    for (const name of BUNDLED_SKILL_NAMES)
      expect(entries, `tarball 缺少 ${name}/SKILL.md`).toContain(`skills/${name}/SKILL.md`);
    expect(entries.some((entry) => entry.endsWith('.ts'))).toBe(false);
    expect(entries.some((entry) => entry.startsWith('src/'))).toBe(false);
  });
});
