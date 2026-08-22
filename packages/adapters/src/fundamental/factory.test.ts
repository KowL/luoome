import { describe, expect, it } from 'vitest';

import { createFundamentalDataAdapterFromEnv, FundamentalProviderIdSchema } from './factory.js';

describe('fundamental/factory', () => {
  it('默认不注入基本面 adapter', () => {
    expect(createFundamentalDataAdapterFromEnv({})).toBeUndefined();
    expect(createFundamentalDataAdapterFromEnv({ LUOOME_FUNDAMENTAL_PROVIDER: '  ' })).toBe(
      undefined,
    );
  });

  it('仅显式 mock 才装配，并保持 gate=not-ready', async () => {
    const adapter = createFundamentalDataAdapterFromEnv({
      LUOOME_FUNDAMENTAL_PROVIDER: 'mock',
    });

    expect(adapter).toBeDefined();
    expect(adapter?.name).toBe('mock-fundamental');
    expect(adapter?.source).toBe('mock-fundamental-pit-fixture');
    expect(adapter?.gateStatus).toBe('not-ready');
    expect(adapter?.gate.status).toBe('not-ready');
    const result = await adapter?.fetchFinancialFactRevisions({ stockIds: ['600000.SH'] });
    expect(result?.gateStatus).toBe('not-ready');
    expect(result?.revisions.length).toBeGreaterThan(0);
  });

  it('未知 provider 在启动装配时明确拒绝，不 fallback 到 market', () => {
    expect(FundamentalProviderIdSchema.safeParse('mock').success).toBe(true);
    expect(() =>
      createFundamentalDataAdapterFromEnv({ LUOOME_FUNDAMENTAL_PROVIDER: 'tushare' }),
    ).toThrow('仅允许 LUOOME_FUNDAMENTAL_PROVIDER=mock');
  });
});
