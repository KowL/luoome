/**
 * 事实库导出物的写盘载体（task-35）。
 *
 * 与 `ReportArtifactWriter`（`report-artifact.ts`）**同一条分层纪律**：
 * **载体 IO 不进 tools** —— 这里只有纯契约，`node:fs` 只出现在宿主实现里。
 *
 * 为什么不复用 `ReportArtifactWriter`：那个的目录语义是 `$LUOOME_HOME/reports`、
 * 文件名由报告期/kind/scopeKey 生成。把「全库归档」写进报告目录会让两类产物混杂，
 * 也会扭曲它的命名规则。所以这里**另立一个契约，但保持同形状**——
 * 交付路径仍然是「tool 写文件 → 返回 presentArgs → 模型调 present」（REQ-M3-08 已确立）。
 */
export interface DataArchiveWriteInput {
  readonly fileName: string;
  readonly content: string;
  readonly overwrite: boolean;
}

export interface DataArchiveWriteResult {
  /** 落盘后的绝对路径。 */
  readonly path: string;
  /** false = 已存在同内容文件，未重写（幂等）。 */
  readonly written: boolean;
  readonly bytes: number;
}

export interface DataArchiveWriter {
  /** 目标目录（绝对路径），由装配方决定（`$LUOOME_HOME/exports`）。 */
  readonly directory: string;
  /** 原子写：同目录临时文件 + rename；目录 0700、文件 0600。 */
  write(input: DataArchiveWriteInput): Promise<DataArchiveWriteResult>;
  /** 读回：用于「文件确实存在」的自检。 */
  read(fileName: string): Promise<string | null>;
}

/** 文件名形状：单段、无路径分隔符、无前导点（与报告产物同一套白名单）。 */
export const DATA_ARCHIVE_FILE_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,180}$/;

/**
 * 归档文件名：`luoome-<上海日期>-<digest 前 12 位>.json`（**命名规则只在这一处**）。
 *
 * 带 digest 前缀原因：同一份数据重复导出会得到**同一个文件名**，
 * 于是 `written: false` 的幂等判断天然成立，不会每天堆一个同名不同内容的文件。
 */
export const dataArchiveFileName = (input: {
  readonly exportedAt: Date;
  readonly digest: string;
}): string => {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(input.exportedAt);
  const digest = input.digest.replace(/[^0-9a-f]/g, '').slice(0, 12) || '000000000000';
  return `luoome-${day}-${digest}.json`;
};
