import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileAuditLogger, sanitizeAuditValue } from './file.js';

describe('FileAuditLogger', () => {
  it('写入 JSONL 并脱敏密钥、Webhook 和超长值', () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-audit-'));
    const filePath = join(root, 'logs', 'audit.log');
    const logger = new FileAuditLogger({ filePath });

    logger.write({
      ts: new Date('2026-08-14T00:00:00.000Z'),
      tool: 'create_account',
      sideEffect: 'write',
      input: {
        apiKey: 'secret-api-key',
        webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/secret-hook',
        error: 'failed at /Users/lijun/.luoome/luoome.db: https://api.example.test/internal',
        note: 'x'.repeat(2_000),
      },
      result: 'ok',
      caller: 'test',
    });

    const raw = readFileSync(filePath, 'utf8');
    expect(raw).not.toContain('secret-api-key');
    expect(raw).not.toContain('secret-hook');
    expect(raw).not.toContain('/Users/lijun');
    expect(raw).not.toContain('api.example.test');
    expect(raw).toContain('create_account');
    expect(statSync(join(root, 'logs')).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(sanitizeAuditValue({ token: 'secret' })).toEqual({ token: '[redacted]' });
  });
});
