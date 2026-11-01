import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDataArchives, DEFAULT_EXPORT_KEEP } from './data-archives.js';

const roots: string[] = [];
const tempDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-exports-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 造一个匹配 `DATA_ARCHIVE_FILE_NAME_PATTERN` 的导出名（`luoome-<日期>-<digest>.json`）。 */
const archiveName = (day: string, digest: string): string =>
  `luoome-${day}-${digest.padEnd(12, '0')}.json`;

describe('task-37 exports/ 保留策略（按份数，白名单）', () => {
  it('保留最近 N 份；不匹配白名单的手工文件不会被删', async () => {
    const directory = tempDir();
    // 2 个手工文件：不符合 `DATA_ARCHIVE_FILE_NAME_PATTERN`（含空格 / 前导点 / 路径分隔符）。
    // 注意：这个 pattern 是**通用安全白名单**（与报告产物同一套），不是「必须是导出名」——
    // `luoome-manual-backup.json` 那种形状**会**匹配，属于会被清理的正常情况。
    writeFileSync(join(directory, 'my notes.txt'), 'hand written');
    writeFileSync(join(directory, '.keep-me'), 'dotfile');
    // 先造 5 份"旧"导出，再让本轮写第 6 份触发清理（keep=3）。
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'])
      writeFileSync(join(directory, archiveName(day, 'a')), '{}');

    const writer = createDataArchives({ directory, keep: 3 });
    await writer.write({
      fileName: archiveName('2026-10-06', 'b'),
      content: '{}\n',
      overwrite: false,
    });

    const left = readdirSync(directory).sort();
    // 最近 3 份导出在。
    expect(left).toContain(archiveName('2026-10-06', 'b'));
    expect(left).toContain(archiveName('2026-10-05', 'a'));
    expect(left).toContain(archiveName('2026-10-04', 'a'));
    // 更早的被清掉。
    expect(left).not.toContain(archiveName('2026-10-01', 'a'));
    expect(left).not.toContain(archiveName('2026-10-02', 'a'));
    // **手工文件必须原样保留** —— 白名单的意义。
    expect(left).toContain('my notes.txt');
    expect(left).toContain('.keep-me');
  });

  it('默认保留 20 份（不传 keep 时）', async () => {
    const directory = tempDir();
    for (let index = 0; index < 25; index += 1) {
      const day = `2026-09-${String(index + 1).padStart(2, '0')}`;
      writeFileSync(join(directory, archiveName(day, 'c')), '{}');
    }
    const writer = createDataArchives({ directory });
    await writer.write({
      fileName: archiveName('2026-10-31', 'd'),
      content: '{}\n',
      overwrite: false,
    });
    const written = readdirSync(directory).filter((name) => name.startsWith('luoome-'));
    expect(written).toHaveLength(DEFAULT_EXPORT_KEEP);
  });

  it('幂等写入（written:false）不触发清理：目录没变就不扫', async () => {
    const directory = tempDir();
    const writer = createDataArchives({ directory, keep: 1 });
    const name = archiveName('2026-10-06', 'e');
    expect(
      (await writer.write({ fileName: name, content: '{}\n', overwrite: false })).written,
    ).toBe(true);
    // 手工塞一个更"旧"的导出；幂等命中时它不该被顺手清掉（本轮没写新文件）。
    const older = archiveName('2026-10-01', 'f');
    writeFileSync(join(directory, older), '{}');
    const again = await writer.write({ fileName: name, content: '{}\n', overwrite: false });
    expect(again.written).toBe(false);
    expect(readdirSync(directory)).toContain(older);
    expect(statSync(join(directory, name)).isFile()).toBe(true);
  });
});
