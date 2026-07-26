import { toolRegistry } from '@luoome/tools';
import { describe, expect, it } from 'vitest';
import { resolveAllowedSideEffects } from './exposure.js';

describe('MCP sideEffect 暴露门控', () => {
  it('agent_run 默认不暴露，仅在 external 显式开启后可见', () => {
    const agentRun = toolRegistry.get('agent_run');
    expect(agentRun?.sideEffect).toBe('external');

    const defaults = resolveAllowedSideEffects({});
    expect(defaults.has('external')).toBe(false);
    expect(defaults.has(agentRun?.sideEffect ?? 'external')).toBe(false);

    const optedIn = resolveAllowedSideEffects({ LUOOME_EXPOSE_EXTERNAL: 'true' });
    expect(optedIn.has('external')).toBe(true);
    expect(optedIn.has(agentRun?.sideEffect ?? 'external')).toBe(true);
  });

  it('trade 硬卡不能由环境变量开启', () => {
    expect(() => resolveAllowedSideEffects({ LUOOME_EXPOSE_TRADE: 'true' })).toThrow(
      /trade tools are never exposed/,
    );
  });
});
