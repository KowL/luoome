import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DSH_TERMINAL_TO_DOMAIN, HostTerminalStatusSchema } from './job-runner.js';

/**
 * REQ-M5-01 第二批：状态映射与分层守卫。
 */
// `packages/core/src` → 仓库根需要**三层**（之前的 `../..` 落在 `packages/`，
// 于是 `walk('packages/tools/src')` 解析成不存在的路径，扫不到任何文件 → 空数组恒真）。
const ROOT = resolve(import.meta.dirname, '../../..');

describe('终态映射：穷举且只覆盖终态', () => {
  it('**只覆盖三个终态**（`running`/`stopping` 不在其中）', () => {
    expect(Object.keys(DSH_TERMINAL_TO_DOMAIN).sort()).toEqual(['completed', 'failed', 'killed']);
    // 这两个**必须不在**：它们不是终态，不该写回领域
    expect(Object.keys(DSH_TERMINAL_TO_DOMAIN)).not.toContain('running');
    expect(Object.keys(DSH_TERMINAL_TO_DOMAIN)).not.toContain('stopping');
  });

  it('映射值都在领域终态集合内', () => {
    expect(Object.values(DSH_TERMINAL_TO_DOMAIN).sort()).toEqual([
      'cancelled',
      'completed',
      'failed',
    ]);
    // **关键**：`killed → cancelled`（名字不同，语义相同）
    expect(DSH_TERMINAL_TO_DOMAIN.killed).toBe('cancelled');
  });

  it('宿主终态枚举恰好三个（对照，防止宿主新增终态被静默漏掉）', () => {
    expect(HostTerminalStatusSchema.options).toEqual(['completed', 'killed', 'failed']);
  });
});

describe('分层守卫：`tools` 零 import DSH', () => {
  it('`packages/tools/src/**` 不出现 `@deepseek-ai/dsh-`', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        // **只查 import 语句**，不查注释里的路径提及
        // （`get-token-usage.ts` 的注释里引用了 dsh-session 的类型文件路径，
        //  那是**说明为什么拿不到用量**，不是依赖）。
        const source = readFileSync(resolve(ROOT, path), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (/(?:from|import)\s*\(?\s*['"]@deepseek-ai\/dsh-/.test(source)) offenders.push(path);
      }
    };
    walk('packages/tools/src');
    // **零 import**：领域只认 core 的窄契约，宿主实现留在 dsh-luoome
    expect(offenders).toEqual([]);
    // 自检：扫描确实扫到了东西（否则空数组没有意义）
    expect(
      readFileSync(resolve(ROOT, 'packages/tools/src/queue/jobs.ts'), 'utf8').length,
    ).toBeGreaterThan(0);
  });
});
