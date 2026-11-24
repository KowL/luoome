import { describe, expect, it } from 'vitest';
import { HostConfigSchema } from './runtime-config.js';

const token = 'controlled-development-token-123456';

const config = (limits?: Record<string, number>) => ({
  configRef: 'fixture-v1',
  gateway: { endpoint: 'http://127.0.0.1:1/tools', token },
  model: { endpoint: 'http://127.0.0.1:1/model', token, model: 'controlled-stub' },
  ...(limits === undefined ? {} : { limits }),
});

describe('Host limits', () => {
  it('keeps the subagent deadline at 60s and the parent follow-up limit at 8 by default', () => {
    const defaults = HostConfigSchema.parse(config()).limits;
    expect(defaults.subagentTimeoutMs).toBe(60000);
    expect(defaults.parentFollowUpTurns).toBe(8);
    expect(defaults.maxModelCalls).toBe(8);
  });

  it('bounds the parent follow-up turns to 1–32', () => {
    for (const parentFollowUpTurns of [1, 32])
      expect(
        HostConfigSchema.parse(config({ parentFollowUpTurns })).limits.parentFollowUpTurns,
      ).toBe(parentFollowUpTurns);
    for (const parentFollowUpTurns of [0, 33])
      expect(() => HostConfigSchema.parse(config({ parentFollowUpTurns }))).toThrow();
  });
});
