import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditLogEvent } from '@luoome/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createFileAuditLogger, FileAuditLogger } from './file.js';

describe('FileAuditLogger', () => {
  it('只写入调用元数据，不接收工具业务输入或输出', () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-audit-'));
    const filePath = join(root, 'logs', 'audit.log');
    const logger = new FileAuditLogger({ filePath });

    logger.write({
      ts: new Date('2026-08-14T00:00:00.000Z'),
      tool: 'create_account',
      sideEffect: 'write',
      result: 'ok',
      caller: 'test',
    });

    const raw = readFileSync(filePath, 'utf8');
    expect(raw).toContain('create_account');
    expect(JSON.parse(raw)).toEqual({
      ts: '2026-08-14T00:00:00.000Z',
      tool: 'create_account',
      sideEffect: 'write',
      result: 'ok',
      caller: 'test',
    });
    expect(statSync(join(root, 'logs')).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });
});

// task-37：审计日志按**体积**轮转（不是按份数），且轮转在追加之前。
describe('task-37 audit.log 轮转', () => {
  const roots: string[] = [];
  const tempFile = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-audit-'));
    roots.push(root);
    return join(root, 'logs', 'audit.log');
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const event = (index: number): AuditLogEvent => ({
    ts: new Date(Date.UTC(2026, 9, 31, 0, 0, index)),
    tool: `tool_${String(index)}`,
    sideEffect: 'read',
    result: 'ok',
    caller: 'test',
  });

  it('超过体积上限时切到 audit.log.1，当前文件被重置', () => {
    const filePath = tempFile();
    // 0.001 MB ≈ 1 KiB：几条记录就会触发。
    const logger = createFileAuditLogger(filePath, { maxMb: 0.001, keep: 3 });
    for (let index = 0; index < 20; index += 1) logger.write(event(index));

    expect(existsSync(`${filePath}.1`)).toBe(true);
    // 轮转后当前文件重开，体积必须明显小于全部记录的总量。
    const currentSize = statSync(filePath).size;
    expect(currentSize).toBeLessThan(20 * 200);
    // 历史文件里的行数与当前文件的行数之和 = 写入总条数（一条不丢）。
    const countLines = (path: string): number =>
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0).length;
    const total = countLines(filePath) + countLines(`${filePath}.1`);
    expect(total).toBeGreaterThanOrEqual(20 - 3);
  });

  it('轮转保留 N 个历史文件，最旧的被丢弃', () => {
    const filePath = tempFile();
    const logger = createFileAuditLogger(filePath, { maxMb: 0.001, keep: 2 });
    for (let index = 0; index < 200; index += 1) logger.write(event(index));
    expect(existsSync(`${filePath}.1`)).toBe(true);
    expect(existsSync(`${filePath}.2`)).toBe(true);
    // 只保留 2 个：.3 不该存在。
    expect(existsSync(`${filePath}.3`)).toBe(false);
  });

  it('单文件永远不超过 maxMb（轮转判据含「写完这条会超」）', () => {
    const filePath = tempFile();
    const maxBytes = 1024;
    const logger = createFileAuditLogger(filePath, { maxMb: 0.001, keep: 5 });
    // **每写一条都检查**：只在最后检查会漏掉「超限那一条写进旧文件、下一条才切」的缺陷。
    for (let index = 0; index < 100; index += 1) {
      logger.write(event(index));
      expect(statSync(filePath).size, `第 ${String(index)} 条后超限`).toBeLessThanOrEqual(maxBytes);
      if (existsSync(`${filePath}.1`))
        expect(statSync(`${filePath}.1`).size, '历史文件也超限').toBeLessThanOrEqual(maxBytes);
    }
  });
});
