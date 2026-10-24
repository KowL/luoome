import { describe, expect, it, vi } from 'vitest';
import { apply, PANEL_TOOLS, panelEnvironment } from './standalone-panels.js';

const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: exec }));

describe('standalone panels', () => {
  it('mounts one authenticated GET route per panel surface and preserves tool values', async () => {
    const register = vi.fn();
    const result = {
      ok: true,
      data: {
        totalPnl: '123.456700',
        confidence: 0.73,
        risks: ['risk'],
        disclaimers: ['disclaimer'],
        counterEvidence: ['counter'],
      },
    };
    exec.mockImplementation((_bin, _args, _options, callback) =>
      callback(null, JSON.stringify(result)),
    );
    apply({ connection: { fetch: { register } } }, { cwd: '/repo', home: '/facts' });
    expect(register).toHaveBeenCalledTimes(4);
    for (const [route] of register.mock.calls) {
      expect(route.methods).toEqual(['GET']);
      const response = await route.fetch(
        new Request(`http://localhost${route.path}?tool=record_trade`),
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      const data = await response.json();
      expect(data.results.map((item: { result: unknown }) => item.result)).toEqual(
        PANEL_TOOLS[data.panel as keyof typeof PANEL_TOOLS].map(() => result),
      );
    }
    expect(exec.mock.calls.map((call) => call[1][4])).toEqual(Object.values(PANEL_TOOLS).flat());
  });

  it('strips exposure flags and does not inherit provider credentials', () => {
    const env = panelEnvironment({
      cwd: '/repo',
      home: '/facts',
      env: {
        LUOOME_EXPOSE_WRITE: 'true',
        LUOOME_EXPOSE_QUEUE: 'true',
        LUOOME_HOME: '/wrong',
        OPENAI_API_KEY: 'do-not-forward',
        LUOOME_MARKET_SOURCES: 'cached',
      },
    });
    expect(env.LUOOME_HOME).toBe('/facts');
    expect(env.LUOOME_MARKET_SOURCES).toBe('cached');
    expect(env.LUOOME_EXPOSE_WRITE).toBeUndefined();
    expect(env.LUOOME_EXPOSE_QUEUE).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
