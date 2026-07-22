import { describe, expect, it } from 'vitest';

import {
  BUILTIN_HOLIDAYS,
  CN_A_SHARE_HOLIDAYS_2026,
  CN_A_SHARE_HOLIDAYS_2027,
  dateInShanghai,
  defaultHolidaysFilePath,
  isHoliday,
  isWeekend,
  loadHolidaysFromFile,
  mergeHolidayCalendars,
  parseEnvHolidays,
  parseHolidayObject,
} from './holidays.js';

const TUESDAY_IN_SHANGHAI = (yyyyMmDd: string, h = 10, m = 0): Date => {
  // 用 Asia/Shanghai 当地的 yyyy-mm-dd hh:mm 构造 UTC Date
  // UTC = local - 8h
  const [y, mo, d] = yyyyMmDd.split('-').map(Number) as [number, number, number];
  const utcMs = Date.UTC(y, mo - 1, d, h - 8, m, 0, 0);
  return new Date(utcMs);
};

describe('dateInShanghai', () => {
  it('Asia/Shanghai 日期字符串（YYYY-MM-DD）', () => {
    // UTC 2026-07-21 06:00 = Shanghai 14:00
    const d = new Date('2026-07-21T06:00:00.000Z');
    expect(dateInShanghai(d)).toBe('2026-07-21');
  });

  it('跨日边界：UTC 16:00 = Shanghai 次日 00:00', () => {
    const d = new Date('2026-07-21T16:00:00.000Z');
    expect(dateInShanghai(d)).toBe('2026-07-22');
  });

  it('年初：UTC 2026-12-31 16:00 = Shanghai 2027-01-01 00:00', () => {
    const d = new Date('2026-12-31T16:00:00.000Z');
    expect(dateInShanghai(d)).toBe('2027-01-01');
  });
});

describe('isWeekend', () => {
  it('周六（Asia/Shanghai）→ true', () => {
    expect(isWeekend(TUESDAY_IN_SHANGHAI('2026-07-25', 10))).toBe(true); // 周六
  });
  it('周日（Asia/Shanghai）→ true', () => {
    expect(isWeekend(TUESDAY_IN_SHANGHAI('2026-07-26', 10))).toBe(true); // 周日
  });
  it('周一（Asia/Shanghai）→ false', () => {
    expect(isWeekend(TUESDAY_IN_SHANGHAI('2026-07-20', 10))).toBe(false);
  });
});

describe('isHoliday（内置 2026 日历）', () => {
  it('元旦 2026-01-01 → true', () => {
    expect(isHoliday(TUESDAY_IN_SHANGHAI('2026-01-01'))).toBe(true);
  });
  it('春节 2026-02-17（周二，假期内）→ true', () => {
    expect(isHoliday(TUESDAY_IN_SHANGHAI('2026-02-17'))).toBe(true);
  });
  it('国庆 2026-10-01（周四）→ true', () => {
    expect(isHoliday(TUESDAY_IN_SHANGHAI('2026-10-01'))).toBe(true);
  });
  it('国庆 2026-10-07（周三，假期末）→ true', () => {
    expect(isHoliday(TUESDAY_IN_SHANGHAI('2026-10-07'))).toBe(true);
  });
  it('普通工作日 2026-09-24（周四，节前一天）→ false', () => {
    expect(isHoliday(TUESDAY_IN_SHANGHAI('2026-09-24'))).toBe(false);
  });
  it('2027 年：内置日历不含 → false（即便默认应当休市）', () => {
    // v0.6 不内置 2027 数据 → 视为工作日（用户应通过 env 补全）
    expect(isHoliday(TUESDAY_IN_SHANGHAI('2027-02-01'))).toBe(false);
  });
});

describe('parseEnvHolidays', () => {
  it('undefined → 空 Map', () => {
    const m = parseEnvHolidays(undefined);
    expect(m.size).toBe(0);
  });
  it('空字符串 → 空 Map', () => {
    expect(parseEnvHolidays('').size).toBe(0);
    expect(parseEnvHolidays('   ').size).toBe(0);
  });
  it('单 token → 单年份单日', () => {
    const m = parseEnvHolidays('2027-02-01');
    expect(m.size).toBe(1);
    expect(m.get(2027)?.has('2027-02-01')).toBe(true);
  });
  it('多 token 含多年 → 分桶', () => {
    const m = parseEnvHolidays('2027-02-01,2027-02-02,2028-10-01');
    expect(m.size).toBe(2);
    expect(m.get(2027)?.size).toBe(2);
    expect(m.get(2028)?.size).toBe(1);
  });
  it('非法 token 跳过', () => {
    const m = parseEnvHolidays('not-a-date,2027-02-01,2027/02/01');
    expect(m.size).toBe(1);
    expect(m.get(2027)?.has('2027-02-01')).toBe(true);
  });
});

describe('mergeHolidayCalendars', () => {
  it('空 → 空 Map', () => {
    expect(mergeHolidayCalendars().size).toBe(0);
  });
  it('单日历：内容一致（不一定同一引用）', () => {
    const merged = mergeHolidayCalendars(BUILTIN_HOLIDAYS);
    expect(merged.get(2026)).toEqual(BUILTIN_HOLIDAYS.get(2026));
  });
  it('合并：env 追加新年份', () => {
    const env = parseEnvHolidays('2027-10-01,2027-10-02');
    const merged = mergeHolidayCalendars(BUILTIN_HOLIDAYS, env);
    // 2026 仍是 BUILTIN_HOLIDAYS 的内容（deep equal）
    expect([...(merged.get(2026) ?? [])].sort()).toEqual(
      [...(BUILTIN_HOLIDAYS.get(2026) ?? [])].sort(),
    );
    expect(merged.get(2027)?.has('2027-10-01')).toBe(true);
  });
  it('合并：env 追加到内置年份（union）', () => {
    const env = parseEnvHolidays('2026-10-08');
    const merged = mergeHolidayCalendars(BUILTIN_HOLIDAYS, env);
    expect(merged.get(2026)?.has('2026-10-08')).toBe(true);
    // 内置原有日期保留
    expect(merged.get(2026)?.has('2026-10-01')).toBe(true);
  });
});

describe('CN_A_SHARE_HOLIDAYS_2026 sanity', () => {
  it('总数合理：元旦 3 + 春节 7 + 清明 3 + 五一 3 + 端午 3 + 中秋 3 + 国庆 7 = 29 天', () => {
    expect(CN_A_SHARE_HOLIDAYS_2026.size).toBe(29);
  });
});

describe('CN_A_SHARE_HOLIDAYS_2027 sanity（v0.7+，best-effort placeholder）', () => {
  it('含 2026 + 2027 两年', () => {
    expect(BUILTIN_HOLIDAYS.size).toBe(2);
    expect(BUILTIN_HOLIDAYS.has(2026)).toBe(true);
    expect(BUILTIN_HOLIDAYS.has(2027)).toBe(true);
  });

  it('2027 关键已知日：元旦 + 春节 + 国庆', () => {
    expect(CN_A_SHARE_HOLIDAYS_2027.has('2027-01-01')).toBe(true); // 元旦
    expect(CN_A_SHARE_HOLIDAYS_2027.has('2027-02-06')).toBe(true); // 除夕
    expect(CN_A_SHARE_HOLIDAYS_2027.has('2027-02-12')).toBe(true); // 初六
    expect(CN_A_SHARE_HOLIDAYS_2027.has('2027-10-01')).toBe(true); // 国庆
    expect(CN_A_SHARE_HOLIDAYS_2027.has('2027-10-07')).toBe(true); // 国庆末
  });

  it('2027 总数在合理区间（20–30 天；强 placeholder 不锁死）', () => {
    expect(CN_A_SHARE_HOLIDAYS_2027.size).toBeGreaterThanOrEqual(20);
    expect(CN_A_SHARE_HOLIDAYS_2027.size).toBeLessThanOrEqual(30);
  });
});

describe('parseHolidayObject（v0.7）', () => {
  it('null / 非 object → 空 Map', () => {
    expect(parseHolidayObject(null).size).toBe(0);
    expect(parseHolidayObject('foo').size).toBe(0);
    expect(parseHolidayObject(42).size).toBe(0);
  });

  it('空 object → 空 Map', () => {
    expect(parseHolidayObject({}).size).toBe(0);
  });

  it('合法多年分桶', () => {
    const raw = { '2026': ['2026-10-08'], '2027': ['2027-10-01', '2027-10-02'] };
    const m = parseHolidayObject(raw);
    expect(m.get(2026)?.has('2026-10-08')).toBe(true);
    expect(m.get(2027)?.size).toBe(2);
  });

  it('key 不是 4 位年份 → 跳过', () => {
    const raw = { abc: ['2026-10-08'], '26': ['2026-10-08'] };
    expect(parseHolidayObject(raw).size).toBe(0);
  });

  it('value 不是 string[] → 跳过该 key', () => {
    const raw = { '2026': 'not-an-array' };
    expect(parseHolidayObject(raw).size).toBe(0);
  });

  it('日期字符串格式错误 → 跳过该元素', () => {
    const raw = { '2026': ['2026-13-01', 'not-a-date', '2026-10-08'] };
    const m = parseHolidayObject(raw);
    expect(m.get(2026)?.has('2026-10-08')).toBe(true);
    expect(m.get(2026)?.size).toBe(1);
  });

  it('日期年份与 key 不一致 → 跳过该元素', () => {
    const raw = { '2026': ['2027-10-01', '2026-10-08'] };
    const m = parseHolidayObject(raw);
    expect(m.get(2026)?.has('2026-10-08')).toBe(true);
    expect(m.get(2026)?.has('2027-10-01')).toBe(false);
  });
});

describe('loadHolidaysFromFile（v0.7）', () => {
  it('文件不存在 → 空 Map（静默）', () => {
    expect(loadHolidaysFromFile('/nonexistent/holidays.json').size).toBe(0);
  });

  it('文件存在 + 合法 JSON → 解析', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'luoome-holidays-'));
    const file = join(dir, 'holidays.json');
    writeFileSync(file, JSON.stringify({ '2027': ['2027-09-29', '2027-10-08'] }), 'utf8');
    try {
      const m = loadHolidaysFromFile(file);
      expect(m.get(2027)?.has('2027-09-29')).toBe(true);
      expect(m.get(2027)?.size).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件存在 + 损坏 JSON → 空 Map（静默）', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'luoome-holidays-'));
    const file = join(dir, 'holidays.json');
    writeFileSync(file, '{ this is not valid json', 'utf8');
    try {
      expect(loadHolidaysFromFile(file).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件存在 + JSON 但不是 object（数组）→ 空 Map（静默）', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'luoome-holidays-'));
    const file = join(dir, 'holidays.json');
    writeFileSync(file, '["2027-10-01"]', 'utf8');
    try {
      expect(loadHolidaysFromFile(file).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('defaultHolidaysFilePath（v0.7）', () => {
  it('拼出 <homeDir>/holidays.json', () => {
    expect(defaultHolidaysFilePath('/some/dir')).toBe('/some/dir/holidays.json');
  });

  it('空 homeDir 也容忍（不抛，结果仍含 holidays.json）', () => {
    // \`join('', 'holidays.json')\` 在 node:path 下产生 'holidays.json'（无前导 /），
    // 这是预期行为：避免污染 API、上层 luoomeHome() 永远是绝对路径，这里仅防御性约束。
    expect(defaultHolidaysFilePath('')).toContain('holidays.json');
  });
});
