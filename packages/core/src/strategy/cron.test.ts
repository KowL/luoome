import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import { nextCronOccurrence, validateCronExpression, validateTimeZone } from './cron.js';

describe('strategy cron', () => {
  it('按时区计算下一个盘后工作日时点', () => {
    expect(
      nextCronOccurrence('0 18 * * 1-5', 'Asia/Shanghai', new Date('2026-08-07T10:01:00.000Z')),
    ).toEqual(new Date('2026-08-10T10:00:00.000Z'));
  });

  it('支持 list/range/step 与星期 7=Sunday', () => {
    expect(
      nextCronOccurrence(
        '*/15 9-10 * * 1,3,5,7',
        'Asia/Shanghai',
        new Date('2026-08-09T00:59:01.000Z'),
      ),
    ).toEqual(new Date('2026-08-09T01:00:00.000Z'));
  });

  it('拒绝非 5 段、越界字段和无效时区', () => {
    expect(() => validateCronExpression('0 18 * *')).toThrow(InvariantError);
    expect(() => validateCronExpression('60 18 * * 1-5')).toThrow(InvariantError);
    expect(() => validateTimeZone('Mars/Olympus')).toThrow(InvariantError);
  });
});
