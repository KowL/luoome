import { describe, expect, it } from 'vitest';

import { dueWeeklyReportDate } from './resources.js';

const SHANGHAI_MONDAY_10 = new Date('2026-11-16T02:00:00Z'); // 周一 10:00 上海
const SHANGHAI_MONDAY_07 = new Date('2026-11-15T23:00:00Z'); // 周一 07:00 上海
const SHANGHAI_TUESDAY = new Date('2026-11-17T02:00:00Z');

describe('weekly report due date', () => {
  it('只在周一 08:00 之后到期', () => {
    expect(dueWeeklyReportDate(SHANGHAI_MONDAY_10)).toBe('2026-11-16');
    expect(dueWeeklyReportDate(SHANGHAI_MONDAY_07)).toBeNull();
    expect(dueWeeklyReportDate(SHANGHAI_TUESDAY)).toBeNull();
  });
});
