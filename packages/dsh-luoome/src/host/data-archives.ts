// 事实库导出物写盘（task-35）。
//
// 边界与 `report-artifacts.ts` 完全一致（同一条分层纪律）：
// - `node:fs` 只在本模块出现；`packages/tools` 不碰文件系统。
// - 目录 0700、文件 0600；写入走「同目录临时文件 + rename」，中途失败不留半文件。
// - 文件名只接受单段白名单形状。
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  DATA_ARCHIVE_FILE_NAME_PATTERN,
  type DataArchiveWriteInput,
  type DataArchiveWriteResult,
  type DataArchiveWriter,
} from '@luoome/core';

export interface DataArchives extends DataArchiveWriter {}

export interface DataArchivesOptions {
  readonly directory: string;
  /**
   * 保留份数（task-37）。默认 20；`LUOOME_EXPORT_KEEP` 可覆盖。
   * 校验走 core 的 `parsePositiveInteger`——与 `LUOOME_BACKUP_KEEP` 同一判据。
   */
  readonly keep?: number;
}

/** 默认保留 20 份导出（单份通常几十 KB 到几 MB，20 份远小于一份备份）。 */
export const DEFAULT_EXPORT_KEEP = 20;

/**
 * 按份数清理（**白名单**）：只有文件名匹配 `DATA_ARCHIVE_FILE_NAME_PATTERN` 的才进候选。
 *
 * 手工扔进 `exports/` 的其它文件天然不会被碰——这和 `upgrade.sh` 的备份保留是同一条纪律：
 * 黑名单永远会漏掉下一个新命名，白名单不会。
 */
const pruneArchives = (directory: string, keep: number): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const candidates = entries
    .filter((name) => DATA_ARCHIVE_FILE_NAME_PATTERN.test(name))
    .filter((name) => {
      try {
        return statSync(join(directory, name)).isFile();
      } catch {
        return false;
      }
    })
    // 文件名是 `luoome-<日期>-<digest>.json`，字典序即日期序；同日内再按 mtime 兜底。
    // **降序**（最新在前），这样 `slice(keep)` 之后剩下的正好是要删的最旧几位。
    .sort((left, right) => {
      const byName = right.localeCompare(left);
      if (byName !== 0) return byName;
      try {
        return statSync(join(directory, right)).mtimeMs - statSync(join(directory, left)).mtimeMs;
      } catch {
        return 0;
      }
    });
  // 已经按「最新在前」降序排好，前 `keep` 个保留，其余删除。
  const removed: string[] = [];
  for (const name of candidates.slice(keep)) {
    try {
      rmSync(join(directory, name), { force: true });
      removed.push(name);
    } catch {
      // 清理失败不影响主流程：导出已经成功，留一份多余文件比让用户拿不到导出安全。
    }
  }
  return removed;
};

const pathFor = (directory: string, fileName: string): string => {
  if (!DATA_ARCHIVE_FILE_NAME_PATTERN.test(fileName))
    throw new Error(`invalid data archive file name: ${fileName}`);
  return join(directory, fileName);
};

export const createDataArchives = (options: DataArchivesOptions): DataArchives => {
  const keep = options.keep ?? DEFAULT_EXPORT_KEEP;
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  chmodSync(options.directory, 0o700);
  return {
    directory: options.directory,
    async write(input: DataArchiveWriteInput): Promise<DataArchiveWriteResult> {
      const target = pathFor(options.directory, input.fileName);
      if (existsSync(target) && !input.overwrite)
        return { path: target, written: false, bytes: statSync(target).size };
      const temp = join(
        options.directory,
        `.${input.fileName}.${randomBytes(6).toString('hex')}.tmp`,
      );
      try {
        writeFileSync(temp, input.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        chmodSync(temp, 0o600);
        renameSync(temp, target);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
      // 只在**真的写了新文件**之后清理：命中幂等（written:false）时目录没变化，不必扫。
      // 清理失败不回滚写入（见 `pruneArchives` 的注释）。
      pruneArchives(options.directory, keep);
      return { path: target, written: true, bytes: Buffer.byteLength(input.content, 'utf8') };
    },
    async read(fileName: string): Promise<string | null> {
      const target = pathFor(options.directory, fileName);
      return existsSync(target) ? readFileSync(target, 'utf8') : null;
    },
  };
};
