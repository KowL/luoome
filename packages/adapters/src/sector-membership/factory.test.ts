import { describe, expect, it } from 'vitest';

import { createSectorMembershipManagerFromEnv } from './factory.js';

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('createSectorMembershipManagerFromEnv', () => {
  it('缺省不装配（返回 undefined）：新端口默认关闭，显式写 fuyao 才启用', () => {
    expect(createSectorMembershipManagerFromEnv({}, { logger: noopLogger })).toBeUndefined();
    expect(
      createSectorMembershipManagerFromEnv(
        { LUOOME_SECTOR_MEMBERSHIP_SOURCES: '  ' },
        { logger: noopLogger },
      ),
    ).toBeUndefined();
  });

  it('显式启用 fuyao 但 FUYAO_API_KEY 缺失 → 启动期失败（§4.3）', () => {
    expect(() =>
      createSectorMembershipManagerFromEnv(
        { LUOOME_SECTOR_MEMBERSHIP_SOURCES: 'fuyao' },
        { logger: noopLogger },
      ),
    ).toThrow(/FUYAO_API_KEY/);
  });

  it('未知或重复来源启动期失败', () => {
    expect(() =>
      createSectorMembershipManagerFromEnv(
        { LUOOME_SECTOR_MEMBERSHIP_SOURCES: 'unknown' },
        { logger: noopLogger },
      ),
    ).toThrow();
    expect(() =>
      createSectorMembershipManagerFromEnv(
        { LUOOME_SECTOR_MEMBERSHIP_SOURCES: 'fuyao,fuyao', FUYAO_API_KEY: 'k' },
        { logger: noopLogger },
      ),
    ).toThrow(/重复/);
  });

  it('配置齐全时装配成功，manager 暴露 sources/status', () => {
    const manager = createSectorMembershipManagerFromEnv(
      { LUOOME_SECTOR_MEMBERSHIP_SOURCES: 'fuyao', FUYAO_API_KEY: 'k' },
      { logger: noopLogger },
    );
    expect(manager).toBeDefined();
    expect(manager?.name).toBe('sector-membership');
    expect(manager?.sources).toEqual(['fuyao']);
    expect(manager?.status().map((entry) => entry.dataset)).toEqual([
      'sector-membership',
      'sector-catalog',
    ]);
  });
});
