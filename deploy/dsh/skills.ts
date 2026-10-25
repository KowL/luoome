/**
 * DSH 技能安装：按 profile 角色决定装哪些技能。
 *
 * 默认 Web profile 只装人看的面需要的技能；`analysis-worker` 属于队列消费端，
 * 只留给手动/隔离验收的 worker profile。历史部署可能已经把 analysis-worker
 * 写进工作区卷，切回 Web 角色时要显式清掉，否则 skill-filesystem 仍会发现它。
 *
 * 安装是「合并 + 定向删除」而不是整目录覆盖：工作区卷会跨容器重启保留，
 * 重复执行必须幂等。
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { StandaloneRole } from '../../packages/dsh-bridge/src/standalone-profile.js';

/** 只在 worker 角色安装的技能目录。 */
export const WORKER_ONLY_SKILLS = ['analysis-worker'] as const;

export interface SkillInstallOptions {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly role: StandaloneRole;
}

export interface SkillInstallPlan {
  /** 本次要安装（或覆盖）的技能目录名，已排序。 */
  readonly install: readonly string[];
  /** 该角色不应存在、需要从目标目录清理掉的技能目录名，已排序。 */
  readonly remove: readonly string[];
}

/** 纯函数：依据源技能清单与角色算出安装/清理计划。 */
export const planSkillInstall = (
  sourceSkillNames: readonly string[],
  role: StandaloneRole,
): SkillInstallPlan => {
  const excluded: ReadonlySet<string> = new Set(role === 'worker' ? [] : WORKER_ONLY_SKILLS);
  const names = [...new Set(sourceSkillNames)].sort();
  return {
    install: names.filter((name) => !excluded.has(name)),
    remove: [...excluded].sort(),
  };
};

/**
 * 把源 skills 目录按角色安装到目标目录，返回本次的安装计划。
 * 目标目录里已有、但本角色不该有的技能会被删除；其它既有目录不动。
 */
export const installSkills = async (options: SkillInstallOptions): Promise<SkillInstallPlan> => {
  await mkdir(options.targetDir, { recursive: true, mode: 0o700 });
  const entries = await readdir(options.sourceDir, { withFileTypes: true });
  const plan = planSkillInstall(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    options.role,
  );
  for (const name of plan.install) {
    await cp(join(options.sourceDir, name), join(options.targetDir, name), { recursive: true });
  }
  for (const name of plan.remove) {
    await rm(join(options.targetDir, name), { recursive: true, force: true });
  }
  return plan;
};
