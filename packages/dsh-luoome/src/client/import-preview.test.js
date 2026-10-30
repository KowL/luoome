import { describe, expect, it } from 'vitest';
import {
  backupSummary,
  canReuseSession,
  clearImportSession,
  digestLabel,
  importDecision,
  importReceipt,
  previewTableRows,
  readImportSession,
  structuralOnlyTables,
  writeImportSession,
} from './import-preview.js';

const memoryStorage = () => {
  const store = new Map();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    keys: () => [...store.keys()],
  };
};

const preview = {
  mode: 'restore-business-v1',
  archiveDigest: 'a'.repeat(64),
  previewHash: 'b'.repeat(64),
  expiresAt: 1000,
  counts: {
    accounts: {
      policy: 'replace',
      source: 1,
      current: 1,
      expected: 1,
      inserted: 0,
      updated: 1,
      deleted: 0,
      unchanged: 0,
    },
    portfolio_performance_snapshots: {
      policy: 'replace',
      source: 0,
      current: 0,
      expected: 0,
      inserted: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
    },
  },
  validation: { accounts: 'domain', portfolio_performance_snapshots: 'structural' },
  structuralOnly: ['portfolio_performance_snapshots'],
  limitations: ['只做结构校验的表：仅校验存储形态'],
};

describe('T48 导入 UI 纯逻辑', () => {
  it('sessionStorage 只存 operationId/requestId/摘要，不存凭证或原始文件', () => {
    const storage = memoryStorage();
    writeImportSession(storage, {
      operationId: 'op-1',
      requestId: 'op-1',
      archiveDigest: 'a'.repeat(64),
      previewHash: 'b'.repeat(64),
      state: 'succeeded',
      token: 'should-not-be-stored',
      file: 'C:/Users/me/luoome.db',
      confirmationToken: 'nope',
    });
    const raw = storage.getItem('luoome-import-session');
    expect(raw).not.toContain('should-not-be-stored');
    expect(raw).not.toContain('luoome.db');
    expect(readImportSession(storage)).toEqual({
      operationId: 'op-1',
      requestId: 'op-1',
      archiveDigest: 'a'.repeat(64),
      previewHash: 'b'.repeat(64),
      state: 'succeeded',
    });
    clearImportSession(storage);
    expect(readImportSession(storage)).toBeNull();
  });

  it('failed 是终态：不得复用旧 operationId', () => {
    expect(canReuseSession({ operationId: 'op', state: 'failed' })).toBe(false);
    expect(canReuseSession({ operationId: 'op', state: 'succeeded' })).toBe(true);
    expect(canReuseSession(null)).toBe(false);
  });

  it('逐表行标出 policy 与校验级别，structural-only 单独可见', () => {
    const rows = previewTableRows(preview);
    expect(rows.map((row) => row.table)).toEqual(['accounts', 'portfolio_performance_snapshots']);
    expect(rows[0]).toMatchObject({ policy: 'replace', validation: 'domain', source: '1' });
    expect(rows[1]).toMatchObject({ validation: 'structural', delta: '0/0/0' });
    expect(structuralOnlyTables(preview)).toEqual(['portfolio_performance_snapshots']);
  });

  it('提交按钮要求先预检、服务端已生成备份，并挡住重复点击', () => {
    const backup = { backupId: 'a'.repeat(32), digest: 'b'.repeat(64), size: 2048, createdAt: 1 };
    expect(importDecision({ preview: null, backup, busy: false })).toMatchObject({
      disabled: true,
    });
    expect(importDecision({ preview, backup: null, busy: false })).toMatchObject({
      disabled: true,
      reason: '请先生成恢复前一致性备份',
    });
    expect(importDecision({ preview, backup, busy: true })).toMatchObject({ disabled: true });
    expect(importDecision({ preview, backup, busy: false, submitting: true })).toMatchObject({
      disabled: true,
      reason: '提交中，请勿重复点击',
    });
    expect(importDecision({ preview, backup, busy: false })).toEqual({
      disabled: false,
      reason: '',
    });
    expect(backupSummary(backup)).toMatchObject({ size: 2 });
    expect(backupSummary(null)).toBeNull();
  });

  it('回执只取有界字段，失败时带上错误说明', () => {
    expect(
      importReceipt({
        operationId: 'op-1',
        state: 'failed',
        result: { ok: false, error: { message: 'commit_busy: 存在未终结的 Operation' } },
        input: { uploadId: 'x' },
      }),
    ).toMatchObject({
      operationId: 'op-1',
      state: 'failed',
      error: 'commit_busy: 存在未终结的 Operation',
    });
    expect(
      importReceipt({
        operationId: 'op-2',
        state: 'succeeded',
        result: {
          ok: true,
          data: {
            requestId: 'op-2',
            archiveDigest: 'c'.repeat(64),
            committedAt: 123,
            actual: { accounts: 1 },
          },
        },
      }),
    ).toMatchObject({
      requestId: 'op-2',
      archiveDigest: 'c'.repeat(64),
      committedAt: 123,
      actual: { accounts: 1 },
    });
    expect(importReceipt(null)).toBeNull();
    expect(digestLabel('a'.repeat(64))).toBe('aaaaaaaaaaaa…');
    expect(digestLabel(undefined)).toBe('—');
  });
});
