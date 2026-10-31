import { InvariantError } from './error/index.js';

/**
 * 报告交付物写盘载体（REQ-M3-08 / S3）。
 *
 * 与 `DataImportStagingAdapter` 同一条分层纪律：**载体 IO 不进 tools**。
 * 这里只有纯契约；`node:fs` 只出现在宿主实现里（`dsh-luoome/src/host/report-artifacts.ts`）。
 */
export interface ReportArtifactWriteInput {
  readonly fileName: string;
  readonly content: string;
  readonly overwrite: boolean;
}

export interface ReportArtifactWriteResult {
  /** 落盘后的绝对路径。 */
  readonly path: string;
  /** false = 已存在同内容文件，未重写（幂等）。 */
  readonly written: boolean;
  readonly bytes: number;
}

export interface ReportArtifactWriter {
  /** 目标目录（绝对路径），由装配方决定（`$LUOOME_HOME/reports`）。 */
  readonly directory: string;
  /** 原子写：同目录临时文件 + rename；目录 0700、文件 0600。 */
  write(input: ReportArtifactWriteInput): Promise<ReportArtifactWriteResult>;
  /** 读回：用于回环解析与「文件确实存在」。 */
  read(fileName: string): Promise<string | null>;
}

/**
 * 允许的文件名形状：单段、无路径分隔符、无前导点。
 *
 * 文件名由 `reportArtifactFileName` 从 kind / 报告期 / scopeKey 生成；用户输入（账户 id、
 * 关注分组 id）只能落在字符白名单里，`../` 之类在生成期就被替换掉，写盘前再校验一次。
 */
export const REPORT_ARTIFACT_FILE_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,180}$/;

const FILE_NAME_MAX_LENGTH = 180;

const slug = (value: string): string =>
  value
    .replace(/[^0-9A-Za-z._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');

/**
 * 稳定文件名：`<报告期>-<kind>-<scopeKey>.md`。
 *
 * 不接受调用方传入的路径片段——所有片段都过字符白名单，避免目录穿越与不可见字符。
 */
export const reportArtifactFileName = (input: {
  readonly kind: string;
  readonly periodEnd: string;
  readonly scopeKey: string;
}): string => {
  const name = slug(`${input.periodEnd}-${input.kind}-${input.scopeKey}`).slice(
    0,
    FILE_NAME_MAX_LENGTH,
  );
  const withExtension = `${name}.md`;
  if (!REPORT_ARTIFACT_FILE_NAME_PATTERN.test(withExtension)) {
    throw new InvariantError(`报告文件名不合法：${withExtension}`);
  }
  return withExtension;
};
