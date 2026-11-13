/* apps/web/public/js/market-room-replay.test.js —— 作战室统一时间轴纯函数（ticket #43）。 */

import { describe, expect, it } from 'bun:test';

import {
  hashWithoutReplayAt,
  parseReplayAt,
  replayAtFromHash,
  replayBannerText,
  replayClockLabel,
  replayEmptyNotice,
  replayHashSuffix,
  replayParam,
  replayQueryPrefix,
  replayQuerySuffix,
  shanghaiDate,
} from './market-room-replay.js';

const NOW = new Date('2026-09-28T12:00:00+08:00');
const at = (time) => new Date(`2026-09-28T${time}+08:00`);

describe('回放时点解析', () => {
  it('带日期的 ISO 原样解析，HH:mm / HH:mm:ss 按上海当天解释', () => {
    expect(parseReplayAt('2026-09-28T10:15:00+08:00', NOW)).toEqual(at('10:15'));
    expect(parseReplayAt('2026-09-28T02:15:00.000Z', NOW)).toEqual(at('10:15'));
    expect(parseReplayAt('2026-09-28T10:15:00', NOW)).toEqual(at('10:15'));
    expect(parseReplayAt('2026-09-28T10:15', NOW)).toEqual(at('10:15'));
    expect(parseReplayAt('2026-09-28T02:15:00-08:00', NOW)).not.toEqual(at('10:15'));
    expect(parseReplayAt('10:15', NOW)).toEqual(at('10:15'));
    expect(parseReplayAt('9:05', NOW)).toEqual(at('09:05'));
    expect(parseReplayAt('10:15:30', NOW)).toEqual(new Date('2026-09-28T10:15:30+08:00'));
    // 上海日期与 UTC 日期不同的时点也按上海当天解释。
    expect(parseReplayAt('10:15', new Date('2026-09-28T16:30:00Z'))).toEqual(
      new Date('2026-09-29T10:15:00+08:00'),
    );
  });

  it('非法 / 缺省时点不当作回放：返回 null 而不是伪造时间', () => {
    for (const raw of ['', '   ', 'abc', '24:00', '10:60', '10:15:99', '2026-13-01T00:00:00Z']) {
      expect(parseReplayAt(raw, NOW), raw).toBeNull();
    }
    expect(parseReplayAt(undefined, NOW)).toBeNull();
    expect(parseReplayAt(null, NOW)).toBeNull();
  });

  it('上海日期换算跨 UTC 日界', () => {
    expect(shanghaiDate(new Date('2026-09-28T15:59:00Z'))).toBe('2026-09-28');
    expect(shanghaiDate(new Date('2026-09-28T16:30:00Z'))).toBe('2026-09-29');
  });
});

describe('hash 往返与规范化', () => {
  it('hash 的 at 可解析；缺省或非法值回退最新模式', () => {
    expect(
      replayAtFromHash('#market-room?tab=events&at=2026-09-28T02%3A15%3A00.000Z', NOW),
    ).toEqual(at('10:15'));
    expect(replayAtFromHash('#market-room?tab=events&at=10%3A15', NOW)).toEqual(at('10:15'));
    expect(replayAtFromHash('#market-room?tab=events', NOW)).toBeNull();
    expect(replayAtFromHash('#market-room?tab=events&at=oops', NOW)).toBeNull();
    expect(replayAtFromHash('', NOW)).toBeNull();
  });

  it('at 统一规范化为 ISO 查询 / hash 片段，最新模式不附加参数', () => {
    expect(replayParam(at('10:15'))).toBe('2026-09-28T02:15:00.000Z');
    expect(replayParam(null)).toBeNull();
    expect(replayQuerySuffix(null)).toBe('');
    expect(replayQuerySuffix(at('10:15'))).toBe('&at=2026-09-28T02%3A15%3A00.000Z');
    expect(replayQueryPrefix(null)).toBe('');
    expect(replayQueryPrefix(at('10:15'))).toBe('?at=2026-09-28T02%3A15%3A00.000Z');
    expect(replayHashSuffix(at('10:15'))).toBe('&at=2026-09-28T02%3A15%3A00.000Z');
  });

  it('回到最新只删除 at，保留 tab / 口径 / 选中事件', () => {
    expect(
      hashWithoutReplayAt(
        '#market-room?tab=sectors&kind=concept&sort=window5&at=2026-09-28T02%3A15%3A00.000Z',
      ),
    ).toBe('market-room?tab=sectors&kind=concept&sort=window5');
    expect(hashWithoutReplayAt('#market-room?tab=events&event=abc')).toBe(
      'market-room?tab=events&event=abc',
    );
    expect(hashWithoutReplayAt('#market-room?at=2026-09-28T02%3A15%3A00.000Z')).toBe('market-room');
    expect(hashWithoutReplayAt('')).toBe('market-room');
  });
});

describe('回放文案', () => {
  it('回放条显示当前时点与「回到最新」，最新模式不显示', () => {
    expect(replayBannerText(null)).toBeNull();
    expect(replayBannerText(at('10:15'))).toBe('回放中 10:15');
    expect(replayClockLabel(at('09:05'))).toBe('09:05');
    expect(replayClockLabel(null)).toBe('--');
  });

  it('早于最早可信样本时给出明确不可回放原因，不伪造零值', () => {
    expect(replayEmptyNotice(null)).toBeNull();
    const notice = replayEmptyNotice(at('09:00'));
    expect(notice).toContain('09:00');
    expect(notice).toContain('不可回放');
    expect(notice).toContain('最早可信样本');
  });
});
