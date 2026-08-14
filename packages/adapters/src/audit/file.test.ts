import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileAuditLogger } from './file.js';

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
