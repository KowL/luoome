import { describe, expect, it } from 'vitest';

import { triangleDataHealthOf, triangleGate } from './triangle-gate.js';

/**
 * REQ-M4-02 需求 4 / 5：门槛与**独立原因码**。
 *
 * ## 为什么两个原因码必须分开（PRD 明文）
 *
 * - `data-unavailable`：数据坏了 → 去修数据源
 * - `market-session-in-trading`：数据好好的，只是时间不对 → 收盘再来
 *
 * 混成一个码，用户会因为「数据不可用」去查一个其实健康的数据源。
 */
describe('三角分析门槛', () => {
  it('dataHealth=unavailable → 拦截，原因码是 data-unavailable', () => {
    const result = triangleGate({ dataHealth: 'unavailable', marketSession: 'closed' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe('data-unavailable');
      // 原因码**不复用 marketSession 的语义**
      expect(result.code).not.toContain('market-session');
    }
  });

  it('盘时段内 → 拦截，原因码是 market-session-in-trading（与数据无关）', () => {
    const result = triangleGate({ dataHealth: 'complete', marketSession: 'trading' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe('market-session-in-trading');
      // **关键**：数据是 complete 的情况下仍被拦，说明拦的是时段不是数据。
      expect(result.code).not.toContain('data');
    }
  });

  it('午间休市同样属于盘时段', () => {
    const result = triangleGate({ dataHealth: 'complete', marketSession: 'midday-break' });
    expect(result.allowed).toBe(false);
  });

  it('两个原因码**互不相同**（可被用户/程序区分）', () => {
    const a = triangleGate({ dataHealth: 'unavailable', marketSession: 'closed' });
    const b = triangleGate({ dataHealth: 'complete', marketSession: 'trading' });
    if (a.allowed || b.allowed) throw new Error('两个用例都应当被拦');
    expect(a.code).not.toBe(b.code);
  });

  it('partial → 允许且**推荐**（PRD 明文）', () => {
    const result = triangleGate({ dataHealth: 'partial', marketSession: 'closed' });
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.recommended).toBe(true);
  });

  it('complete → 允许但不特别推荐', () => {
    const result = triangleGate({ dataHealth: 'complete', marketSession: 'closed' });
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.recommended).toBe(false);
  });

  it('收盘后 / 盘前 / 非交易日都可开启', () => {
    for (const session of ['closed', 'pre-open', 'non-trading-day'] as const) {
      const result = triangleGate({ dataHealth: 'complete', marketSession: session });
      expect(result.allowed, `${session} 应当允许`).toBe(true);
    }
  });

  it('数据不可用**优先于**时段判断（先修数据再谈时间）', () => {
    const result = triangleGate({ dataHealth: 'unavailable', marketSession: 'trading' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('data-unavailable');
  });

  it('单票快问场景：**标注不推荐但不硬拦**（PRD 需求 5 后半句）', () => {
    const result = triangleGate({
      dataHealth: 'complete',
      marketSession: 'closed',
      scenario: 'single-stock-quick-question',
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.advisories.join('')).toContain('不推荐');
      // 提醒存在，但 allowed 仍是 true —— **提醒永不阻止**。
      expect(result.advisories.length).toBeGreaterThan(0);
    }
  });
});

describe('dataHealth 推导规则（PRD 未定义，此处定死）', () => {
  const status = (datasets: { state: string }[], watchlistStale: unknown[] = []) => ({
    datasets,
    watchlistStale,
  });

  it('**没有任何数据集** → unavailable（不是「有缺口」而是「没有输入」）', () => {
    expect(triangleDataHealthOf(status([]))).toBe('unavailable');
  });

  it('**全部 failed** → unavailable（一个能读的都没有）', () => {
    expect(triangleDataHealthOf(status([{ state: 'failed' }, { state: 'failed' }]))).toBe(
      'unavailable',
    );
  });

  it('有 stale → partial（有数据但不可全信）', () => {
    expect(triangleDataHealthOf(status([{ state: 'ok' }, { state: 'stale' }]))).toBe('partial');
  });

  it('部分 failed 但有可用的 → partial（不是 unavailable）', () => {
    expect(triangleDataHealthOf(status([{ state: 'ok' }, { state: 'failed' }]))).toBe('partial');
  });

  it('watchlistStale 非空 → partial（结论会基于旧事实）', () => {
    expect(triangleDataHealthOf(status([{ state: 'ok' }], [{}]))).toBe('partial');
  });

  it('全部 ok 且无 stale → complete', () => {
    expect(triangleDataHealthOf(status([{ state: 'ok' }, { state: 'ok' }]))).toBe('complete');
  });

  it('**只有一条 ok、其余 failed → partial**（分界线在「有没有至少一条能读」）', () => {
    // 这条与「全部 failed → unavailable」并排，才说明规则不是拍脑袋的：
    // 分界线不是「failed 的比例」，而是「有没有至少一条能读」。
    expect(
      triangleDataHealthOf(status([{ state: 'ok' }, { state: 'failed' }, { state: 'failed' }])),
    ).toBe('partial');
    // 反向：同一条 ok 拿掉就变成 unavailable
    expect(triangleDataHealthOf(status([{ state: 'failed' }, { state: 'failed' }]))).toBe(
      'unavailable',
    );
  });

  it('**unavailable 与 partial 的边界**：全靠读不出来 vs 有一部分读不出来', () => {
    // 这条是规则的核心：两者处置完全不同（前者拦，后者继续并产缺口清单）。
    const allDead = triangleDataHealthOf(status([{ state: 'failed' }]));
    const someDead = triangleDataHealthOf(status([{ state: 'ok' }, { state: 'failed' }]));
    expect(allDead).toBe('unavailable');
    expect(someDead).toBe('partial');
    expect(allDead).not.toBe(someDead);
  });
});
