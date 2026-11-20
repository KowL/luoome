import { describe, expect, it } from 'vitest';
import { assertTradeNeverExposed, isToolExposed, resolveExposure } from './exposure.js';

describe('exposure', () => {
  it('默认只放行 read 与 advice', () => {
    const exposure = resolveExposure({});
    expect([...exposure.sideEffects].sort()).toEqual(['advice', 'read']);
    expect(exposure.write).toBe(false);
    expect(exposure.external).toBe(false);
  });

  it('显式开启 write/external，也可用启动参数覆盖 env', () => {
    expect(
      resolveExposure({ LUOOME_EXPOSE_WRITE: 'true', LUOOME_EXPOSE_EXTERNAL: 'true' }),
    ).toMatchObject({ write: true, external: true });
    expect(
      resolveExposure({ LUOOME_EXPOSE_WRITE: 'true' }, { write: false }).sideEffects,
    ).not.toContain('write');
    expect(resolveExposure({}, { external: true }).sideEffects.has('external')).toBe(true);
  });

  it('read/advice 可显式关闭', () => {
    const exposure = resolveExposure({
      LUOOME_EXPOSE_READ: 'false',
      LUOOME_EXPOSE_ADVICE: 'false',
    });
    expect(exposure.sideEffects.size).toBe(0);
  });

  it('trade 在任何 surface 都硬卡', () => {
    expect(() => resolveExposure({ LUOOME_EXPOSE_TRADE: 'true' })).toThrow(/trade 永不暴露/);
    expect(() => assertTradeNeverExposed({ LUOOME_EXPOSE_TRADE: 'true' })).toThrow();
    expect(() => assertTradeNeverExposed({ LUOOME_EXPOSE_TRADE: 'false' })).not.toThrow();
  });

  it('tool 的每项能力都要落在暴露面内', () => {
    const readOnly = resolveExposure({});
    const full = resolveExposure({ LUOOME_EXPOSE_WRITE: 'true', LUOOME_EXPOSE_EXTERNAL: 'true' });
    const writeTool = { sideEffect: 'write' as const };
    const syncTool = {
      sideEffect: 'read' as const,
      requiredCapabilities: ['write', 'external'] as const,
    };
    expect(isToolExposed(writeTool, readOnly)).toBe(false);
    expect(isToolExposed(writeTool, full)).toBe(true);
    expect(isToolExposed(syncTool, readOnly)).toBe(false);
    expect(isToolExposed(syncTool, full)).toBe(true);
  });
});
