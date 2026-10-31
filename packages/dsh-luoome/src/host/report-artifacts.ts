// 报告交付物写盘（REQ-M3-08 / S3）。
//
// 边界（与 data-import 同一条纪律）：
// - `node:fs` 只在本模块出现；`packages/tools` 不碰文件系统。
// - 目录 0700、文件 0600；写入走「同目录临时文件 + rename」，中途失败不留半文件。
// - 文件名只接受单段白名单形状，用户输入（账户/分组 id）在生成期已过白名单，这里再校验一次。
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
  REPORT_ARTIFACT_FILE_NAME_PATTERN,
  type ReportArtifactWriteInput,
  type ReportArtifactWriteResult,
  type ReportArtifactWriter,
} from '@luoome/core';

export interface ReportArtifactsOptions {
  /** `$LUOOME_HOME/reports`；本模块负责创建为 0700。 */
  readonly directory: string;
}

export interface ReportArtifacts extends ReportArtifactWriter {}

const pathFor = (directory: string, fileName: string): string => {
  if (!REPORT_ARTIFACT_FILE_NAME_PATTERN.test(fileName)) {
    throw new Error(`invalid report artifact file name: ${fileName}`);
  }
  return join(directory, fileName);
};

export const createReportArtifacts = (options: ReportArtifactsOptions): ReportArtifacts => {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  chmodSync(options.directory, 0o700);
  return {
    directory: options.directory,
    async write(input: ReportArtifactWriteInput): Promise<ReportArtifactWriteResult> {
      const target = pathFor(options.directory, input.fileName);
      if (existsSync(target) && !input.overwrite) {
        return { path: target, written: false, bytes: statSync(target).size };
      }
      const temp = join(
        options.directory,
        `.${input.fileName}.${randomBytes(6).toString('hex')}.tmp`,
      );
      try {
        writeFileSync(temp, input.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        chmodSync(temp, 0o600);
        // 同目录 rename：要么旧文件完好，要么新文件完整，不会出现半写文件。
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
