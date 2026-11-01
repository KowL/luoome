import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { AuditLogEvent, AuditLoggerLike } from '@luoome/core';

export interface FileAuditLoggerOptions {
  readonly filePath: string;
  /**
   * 单个日志文件的体积上限（MB）。默认 20，`LUOOME_AUDIT_MAX_MB` 可覆盖。
   *
   * **按体积而不是按份数触发**：审计日志是高频追加，条数没意义（每条约 200 字节，
   * 一天几千条也才 1 MB）；真正会让磁盘爆的是「长期不切」。
   */
  readonly maxMb?: number;
  /** 轮转后保留几个历史文件（`audit.log.1` … `audit.log.N`）。默认 5。 */
  readonly keep?: number;
}

export const DEFAULT_AUDIT_MAX_MB = 20;
export const DEFAULT_AUDIT_KEEP = 5;

const ONE_MB = 1024 * 1024;

/**
 * 轮转：`audit.log` → `audit.log.1` → … → `audit.log.N`，最旧的丢弃。
 *
 * 用 `rename` 而不是复制：拷贝几百 MB 的日志会制造一次 IO 峰值，
 * 而 `rename` 是同一文件系统内的元数据操作。
 *
 * **必须在追加之前调用**：否则超限后要等下一次写入才切，那一条就落进了没切走的旧文件，
 * 「单文件不超过 maxMb」这条保证会失效。
 */
const rotate = (filePath: string, keep: number): void => {
  // 从最旧的开始往新的挪：先删 `.N`，再把 `.N-1` 挪成 `.N` …
  rmSync(`${filePath}.${keep}`, { force: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    if (existsSync(source)) renameSync(source, `${filePath}.${index + 1}`);
  }
  if (existsSync(filePath)) renameSync(filePath, `${filePath}.1`);
};

/** JSONL 审计文件实现；生产 surface 各自注入同一 home 下的 logs/audit.log。 */
export class FileAuditLogger implements AuditLoggerLike {
  constructor(private readonly options: FileAuditLoggerOptions) {}

  write(event: AuditLogEvent): void {
    const line = {
      ts: event.ts.toISOString(),
      tool: event.tool,
      sideEffect: event.sideEffect,
      result: event.result,
      ...(event.errorKind === undefined ? {} : { errorKind: event.errorKind }),
      caller: event.caller,
    };
    const payload = `${JSON.stringify(line)}\n`;
    const directory = dirname(this.options.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);

    // 先判体积再追加：超过上限就切走当前文件，新记录写进空的 audit.log。
    const maxBytes = (this.options.maxMb ?? DEFAULT_AUDIT_MAX_MB) * ONE_MB;
    const keep = this.options.keep ?? DEFAULT_AUDIT_KEEP;
    if (existsSync(this.options.filePath)) {
      const size = statSync(this.options.filePath).size;
      // 以「写完这一条之后会超」为判据，避免正好卡在边界的那一条把文件顶过上限。
      if (size + Buffer.byteLength(payload, 'utf8') > maxBytes) rotate(this.options.filePath, keep);
    }

    appendFileSync(this.options.filePath, payload, { encoding: 'utf8', mode: 0o600 });
    chmodSync(this.options.filePath, 0o600);
  }
}

export const createFileAuditLogger = (
  filePath: string,
  options: { readonly maxMb?: number; readonly keep?: number } = {},
): FileAuditLogger => new FileAuditLogger({ filePath, ...options });
