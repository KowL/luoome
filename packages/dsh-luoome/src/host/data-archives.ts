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

const pathFor = (directory: string, fileName: string): string => {
  if (!DATA_ARCHIVE_FILE_NAME_PATTERN.test(fileName))
    throw new Error(`invalid data archive file name: ${fileName}`);
  return join(directory, fileName);
};

export const createDataArchives = (options: { readonly directory: string }): DataArchives => {
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
      return { path: target, written: true, bytes: Buffer.byteLength(input.content, 'utf8') };
    },
    async read(fileName: string): Promise<string | null> {
      const target = pathFor(options.directory, fileName);
      return existsSync(target) ? readFileSync(target, 'utf8') : null;
    },
  };
};
