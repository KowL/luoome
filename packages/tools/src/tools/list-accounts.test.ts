import { MOCK_ACCOUNT } from '@luoome/adapters';
import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { listAccountsTool } from './list-accounts.js';

describe('list_accounts', () => {
  it('正常路径：返回全部账户', async () => {
    const ctx = await buildMockContext();
    const result = await listAccountsTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(1);
    expect(result.data.accounts).toHaveLength(1);
    expect(result.data.accounts[0]?.id).toBe(MOCK_ACCOUNT.id);
    expect(result.data.accounts[0]?.name).toBe(MOCK_ACCOUNT.name);
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
