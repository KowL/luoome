// M4-09 守卫：用户可见的入口下线说明。
//
// ## 为什么需要守卫
//
// 四个入口（CLI / TUI / stdio MCP / 旧 Web 看板）删掉后，界面上**没有任何地方**
// 告诉用户「那些入口去哪了」。能力没丢、但路径变了——不说清楚，用户只会以为功能没了。
// 而这类「说明性文案」最容易在后续重构中被悄悄删掉或改坏，功能测试不会红。
//
// 同时守两条呈现纪律（本会话踩过教训的）：
// 1. **不许用 warning/红黄**——那会变成每天看到的常态告警（同 M3-20「每天报历史观察」）
// 2. **替代路径必须具体**——只写「用插件」等于没说
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CLIENT_ROOT = resolve(import.meta.dirname);
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const read = (path) => readFileSync(path, 'utf8');
const settings = read(resolve(CLIENT_ROOT, 'settings.js'));
const changelog = read(resolve(REPO_ROOT, 'CHANGELOG.md'));
const prd = read(resolve(REPO_ROOT, 'docs/prd/dsh-plugin-consolidation.md'));

/** 从 `settings.js` 里切出 `RETIRED_ENTRIES` 数组源码。 */
const entriesSource = () => {
  const start = settings.indexOf('export const RETIRED_ENTRIES = [');
  const end = settings.indexOf('];', start);
  if (start < 0 || end < 0) throw new Error('找不到 RETIRED_ENTRIES');
  return settings.slice(start, end);
};
const entries = () => {
  const source = entriesSource();
  // 逐条切成 `{ ... }`（条目里没有嵌套花括号，按 `},\n  {` 分块即可）。
  return source
    .split(/\},\s*\{/)
    .map((chunk) =>
      chunk
        .replace(/^\s*export const RETIRED_ENTRIES = \[\s*\{?/, '')
        .replace(/\},?\s*\]?;?\s*$/, ''),
    )
    .filter((chunk) => chunk.includes('key:'));
};
const fieldOf = (chunk, field) => {
  const match = chunk.match(new RegExp(`${field}:\\s*'([^']*)'`));
  return match === null ? null : match[1];
};

describe('入口下线说明（M4-09）', () => {
  it('四个入口都在，且 key 唯一', () => {
    const list = entries();
    const keys = list.map((chunk) => fieldOf(chunk, 'key')).sort();
    expect(keys).toEqual(['cli', 'mcp', 'tui', 'web']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('**每一条都必须带具体替代路径**（不能只写「已下线」）', () => {
    for (const chunk of entries()) {
      const key = fieldOf(chunk, 'key');
      const replacement = fieldOf(chunk, 'replacement');
      expect(replacement, `${key} 缺少替代路径`).not.toBeNull();
      // 「具体」的判据：要足够长，且提到具体的落点（视图/工具/面板），
      // 不能是「用插件」「请参考文档」这类空话。
      expect((replacement ?? '').length, `${key} 的替代路径太短，像空话`).toBeGreaterThan(20);
      expect(
        /视图|面板|工具|registry|对话/.test(replacement ?? ''),
        `${key} 的替代路径没有指向具体落点：${String(replacement)}`,
      ).toBe(true);
    }
  });

  it('每一条都带 PRD 的 R 编号', () => {
    for (const chunk of entries()) {
      const key = fieldOf(chunk, 'key');
      const r = fieldOf(chunk, 'r');
      expect(r, `${key} 缺少 R 编号`).toMatch(/^REQ-M\d+-\d+$/);
      // 编号必须真的存在于 PRD（防止写一个不存在的编号）
      expect(prd.includes(r ?? ''), `${key} 的编号 ${String(r)} 在 PRD 里找不到`).toBe(true);
    }
  });

  it('呈现用 factual，不是 warning/红黄（否则会变成每天看到的常态告警）', () => {
    const section = settings.slice(
      settings.indexOf('function RetiredEntriesSection'),
      settings.indexOf('export function SettingsPanel'),
    );
    expect(section).toContain("tone: 'factual'");
    for (const banned of [
      "tone: 'warn'",
      "tone: 'error'",
      "tone: 'warning'",
      'is-warn',
      'is-error',
    ])
      expect(section, `入口变更区块不得用 ${banned}`).not.toContain(banned);
  });

  it('文案不含行动词（这里不是投资建议）', () => {
    const source = entriesSource();
    for (const word of ['买入', '卖出', '已建仓', '下单', '建仓']) {
      expect(source, `入口说明里出现了行动词：${word}`).not.toContain(word);
    }
  });
});

describe('CHANGELOG（M4-09）', () => {
  it('三个下线条目的 R 编号都能在 PRD 里对上', () => {
    for (const r of ['REQ-M2-05', 'REQ-M2-03', 'REQ-M4-01']) {
      expect(changelog.includes(r), `CHANGELOG 缺 ${r}`).toBe(true);
      expect(prd.includes(r), `PRD 里没有 ${r}`).toBe(true);
    }
  });

  it('对不上的变更**显式标注**为无编号，不硬凑', () => {
    // 编造编号比不给编号更糟：会让追溯链断在一个假节点上。
    expect(changelog).toContain('无 PRD 编号的内部变更');
  });

  it('CLI/TUI 的编号是 REQ-M2-05（不是 T15 之类的旧称）', () => {
    const source = entriesSource();
    const cliEntry = entries().find((chunk) => fieldOf(chunk, 'key') === 'cli');
    const tuiEntry = entries().find((chunk) => fieldOf(chunk, 'key') === 'tui');
    expect(fieldOf(cliEntry ?? '', 'r')).toBe('REQ-M2-05');
    expect(fieldOf(tuiEntry ?? '', 'r')).toBe('REQ-M2-05');
    expect(source).not.toContain('T15');
  });
});
