import { MOCK_ACCOUNT } from '@luoome/adapters';
import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { getAccountTool } from './get-account.js';

describe('get_account', () => {
  it('正常路径：缺省 accountId → 默认账户', async () => {
    const ctx = await buildMockContext();
    const result = await getAccountTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.account.id).toBe(MOCK_ACCOUNT.id);
    expect(result.data.account.kind).toBe('mock');
    expect(result.data.account.currency).toBe('CNY');
  });

  it('正常路径：显式 accountId', async () => {
    const ctx = await buildMockContext();
    const result = await getAccountTool.execute({ accountId: MOCK_ACCOUNT.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.account.name).toBe(MOCK_ACCOUNT.name);
  });

  it('错误路径：账户不存在 → not_found', async () => {
    const ctx = await buildMockContext();
    const result = await getAccountTool.execute({ accountId: 'no-such-account' }, ctx);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Account', id: 'no-such-account' },
    });
  });

  it('错误路径：空字符串 id → invalid_input', async () => {
    const ctx = await buildMockContext();
    const result = await getAccountTool.execute({ accountId: '' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });
});
