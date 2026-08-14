import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AuditLogEvent, AuditLoggerLike } from '@luoome/core';

const SENSITIVE_KEY =
  /(api[-_]?key|token|secret|password|authorization|webhook|cookie|credential)/i;
const SENSITIVE_VALUE =
  /(Bearer\s+|sk-[A-Za-z0-9_-]+|https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/)[^\s"']+/gi;
const INTERNAL_VALUE =
  /https?:\/\/[^\s"'`]+|\/(?:Users|home|private|tmp|var|opt|etc|Volumes|workspace)\/[^\s"'`)]+|[A-Za-z]:\\[^\s"'`)]+/gi;
const MAX_STRING_LENGTH = 1_000;
const MAX_COLLECTION_ITEMS = 64;
const MAX_OBJECT_KEYS = 64;

/** 审计文件只接受脱敏后的结构化值，避免把密钥或完整上游响应写入磁盘。 */
export const sanitizeAuditValue = (value: unknown, key?: string, depth = 0): unknown => {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return '[redacted]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const redacted = value
      .replace(SENSITIVE_VALUE, '[redacted]')
      .replace(INTERNAL_VALUE, '[redacted]');
    return redacted.length > MAX_STRING_LENGTH
      ? `${redacted.slice(0, MAX_STRING_LENGTH)}…`
      : redacted;
  }
  if (typeof value === 'bigint') return String(value);
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => sanitizeAuditValue(item, undefined, depth + 1));
    if (value.length > MAX_COLLECTION_ITEMS) items.push('[truncated]');
    return items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [entryKey, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
      out[entryKey] = sanitizeAuditValue(entryValue, entryKey, depth + 1);
    }
    if (entries.length > MAX_OBJECT_KEYS) out.__truncated__ = true;
    return out;
  }
  return String(value);
};

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
      input: sanitizeAuditValue(event.input),
      result: event.result,
      ...(event.output === undefined ? {} : { output: sanitizeAuditValue(event.output) }),
      ...(event.error === undefined ? {} : { error: sanitizeAuditValue(event.error) }),
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
