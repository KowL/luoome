import { describe, expect, it } from 'vitest';
import { queueProbeState } from './queue-probe.js';

const metrics = (readyPending: number, expired: number) =>
  JSON.stringify({ ok: true, data: { readyPending, claimExpiredNotRecycled: { count: expired } } });
describe('consumer wakeup probe', () => {
  it('wakes for runnable work or an expired claim, but not delayed work', () => {
    expect(queueProbeState(0, metrics(1, 0))).toBe('ready');
    expect(queueProbeState(0, metrics(0, 1))).toBe('ready');
    expect(queueProbeState(0, metrics(0, 0))).toBe('empty');
  });
  it('never spends model tokens on command errors or malformed tool output', () => {
    for (const output of [
      '',
      '{}',
      '{"ok":false}',
      'logs before JSON',
      '{"ok":true,"data":{"readyPending":"1"}}',
    ])
      expect(queueProbeState(0, output)).toBe('error');
    expect(queueProbeState(1, metrics(1, 0))).toBe('error');
    expect(queueProbeState(null, metrics(1, 0))).toBe('error');
  });
});
