import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AuditLogEvent, AuditLoggerLike } from '@luoome/core';

export interface FileAuditLoggerOptions {
  readonly filePath: string;
}

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
    const directory = dirname(this.options.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    appendFileSync(this.options.filePath, `${JSON.stringify(line)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(this.options.filePath, 0o600);
  }
}

export const createFileAuditLogger = (filePath: string): FileAuditLogger =>
  new FileAuditLogger({ filePath });
