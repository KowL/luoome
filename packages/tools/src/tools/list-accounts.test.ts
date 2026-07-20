import { MOCK_ACCOUNT, MOCK_ACCOUNT_LONGTERM, MOCK_ACCOUNT_SHORTTERM } from '@luoome/adapters';
import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { listAccountsTool } from './list-accounts.js';

describe('list_accounts', () => {
  it('正常路径：返回全部账户', async () => {
    const ctx = await buildMockContext();
    const result = await listAccountsTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(3);
    expect(result.data.accounts).toHaveLength(3);
    const ids = result.data.accounts.map((a) => a.id);
    expect(ids).toContain(MOCK_ACCOUNT.id);
    expect(ids).toContain(MOCK_ACCOUNT_LONGTERM.id);
    expect(ids).toContain(MOCK_ACCOUNT_SHORTTERM.id);
    const names = result.data.accounts.map((a) => a.name);
    expect(names).toContain(MOCK_ACCOUNT.name);
    expect(names).toContain(MOCK_ACCOUNT_LONGTERM.name);
    expect(names).toContain(MOCK_ACCOUNT_SHORTTERM.name);
  });

  it('空输入（undefined）也可接受（schema 有默认值）', async () => {
    const ctx = await buildMockContext();
    const result = await listAccountsTool.execute(undefined, ctx);
    expect(result.ok).toBe(true);
  });

  it('错误路径：非对象输入 → invalid_input', async () => {
    const ctx = await buildMockContext();
    const result = await listAccountsTool.execute('nope', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });
});
