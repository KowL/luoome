import { describe, expect, it } from 'vitest';

import { EastmoneyLimitUpPoolEnricher } from './eastmoney-pool.js';

const mkResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('EastmoneyLimitUpPoolEnricher', () => {
  it('fbt/lbt HHMMSS int → HH:MM:SS；hybk → industry', async () => {
    const enricher = new EastmoneyLimitUpPoolEnricher((async () =>
      mkResponse({
        rc: 0,
        data: {
          tc: 2,
          pool: [
            { c: '000533', n: '顺钠股份', fbt: 92500, lbt: 92500, hybk: '电网设备', zbc: 0 },
            { c: '002879', n: '长缆科技', fbt: 142842, lbt: 142842, hybk: '电力', zbc: 3 },
          ],
        },
      })) as unknown as typeof fetch);
    const pool = await enricher.fetchPool('2026-07-24');
    expect(pool.get('000533')).toEqual({
      firstTime: '09:25:00',
      finalTime: '09:25:00',
      industry: '电网设备',
    });
    expect(pool.get('002879')).toEqual({
      firstTime: '14:28:42',
      finalTime: '14:28:42',
      industry: '电力',
    });
  });

  it('fbt/lbt 为 0 或缺失 → undefined', async () => {
    const enricher = new EastmoneyLimitUpPoolEnricher((async () =>
      mkResponse({
        rc: 0,
        data: { tc: 1, pool: [{ c: '600001', n: 'A', fbt: 0, hybk: '' }] },
      })) as unknown as typeof fetch);
    const pool = await enricher.fetchPool('2026-07-24');
    expect(pool.get('600001')).toEqual({
      firstTime: undefined,
      finalTime: undefined,
      industry: undefined,
    });
  });

  it('data 为 null（非交易日）→ 空 Map', async () => {
    const enricher = new EastmoneyLimitUpPoolEnricher((async () =>
      mkResponse({ rc: 0, data: null })) as unknown as typeof fetch);
    const pool = await enricher.fetchPool('2026-07-25');
    expect(pool.size).toBe(0);
  });

  it('HTTP 非 ok → throw', async () => {
    const enricher = new EastmoneyLimitUpPoolEnricher((async () =>
      mkResponse({}, 500)) as unknown as typeof fetch);
    await expect(enricher.fetchPool('2026-07-24')).rejects.toThrow(/HTTP 500/);
  });

  it('网络错误 → throw', async () => {
    const enricher = new EastmoneyLimitUpPoolEnricher((async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch);
    await expect(enricher.fetchPool('2026-07-24')).rejects.toThrow(/socket hang up/);
  });

  it('请求 URL 携带 YYYYMMDD 日期', async () => {
    let captured = '';
    const enricher = new EastmoneyLimitUpPoolEnricher((async (url: string | URL) => {
      captured = String(url);
      return mkResponse({ rc: 0, data: null });
    }) as unknown as typeof fetch);
    await enricher.fetchPool('2026-07-24');
    expect(captured).toContain('date=20260724');
    expect(captured).toContain('dpt=wz.ztzt');
  });
});
