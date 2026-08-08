import { InvariantError } from '../error/index.js';

interface CronField {
  readonly values: ReadonlySet<number>;
  readonly unrestricted: boolean;
}

interface ParsedCron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

const integer = (raw: string, label: string): number => {
  if (!/^\d+$/.test(raw)) throw new InvariantError(`cron ${label} 含非整数值: ${raw}`);
  return Number(raw);
};

const parseField = (
  raw: string,
  min: number,
  max: number,
  label: string,
  normalize: (value: number) => number = (value) => value,
): CronField => {
  const values = new Set<number>();
  for (const token of raw.split(',')) {
    if (token.length === 0) throw new InvariantError(`cron ${label} 存在空项`);
    const [base, stepRaw, ...extra] = token.split('/');
    if (extra.length > 0 || base === undefined) {
      throw new InvariantError(`cron ${label} 步长格式无效: ${token}`);
    }
    const step = stepRaw === undefined ? 1 : integer(stepRaw, label);
    if (step <= 0) throw new InvariantError(`cron ${label} 步长必须大于 0`);
    let start: number;
    let end: number;
    if (base === '*') {
      start = min;
      end = max;
    } else if (base.includes('-')) {
      const [startRaw, endRaw, ...rangeExtra] = base.split('-');
      if (rangeExtra.length > 0 || startRaw === undefined || endRaw === undefined) {
        throw new InvariantError(`cron ${label} 范围格式无效: ${base}`);
      }
      start = integer(startRaw, label);
      end = integer(endRaw, label);
    } else {
      start = integer(base, label);
      end = stepRaw === undefined ? start : max;
    }
    if (start < min || start > max || end < min || end > max || start > end) {
      throw new InvariantError(`cron ${label} 超出范围 ${min}-${max}: ${token}`);
    }
    for (let value = start; value <= end; value += step) values.add(normalize(value));
  }
  return { values, unrestricted: raw === '*' };
};

const parseCron = (expression: string): ParsedCron => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new InvariantError('cron 必须为 5 段：分 时 日 月 周');
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    minute: parseField(minute, 0, 59, '分钟'),
    hour: parseField(hour, 0, 23, '小时'),
    dayOfMonth: parseField(dayOfMonth, 1, 31, '日'),
    month: parseField(month, 1, 12, '月'),
    dayOfWeek: parseField(dayOfWeek, 0, 7, '星期', (value) => (value === 7 ? 0 : value)),
  };
};

export const validateCronExpression = (expression: string): void => {
  parseCron(expression);
};

export const validateTimeZone = (timezone: string): void => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new InvariantError(`无效时区: ${timezone}`);
  }
};

const formatterFor = (timezone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  });

const WEEKDAY: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const localParts = (instant: Date, formatter: Intl.DateTimeFormat) => {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const weekday = WEEKDAY[parts.weekday ?? ''];
  if (weekday === undefined) throw new InvariantError('无法解析 cron 时区日期');
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: weekday,
  };
};

const matches = (cron: ParsedCron, instant: Date, formatter: Intl.DateTimeFormat): boolean => {
  const parts = localParts(instant, formatter);
  const dayOfMonthMatches = cron.dayOfMonth.values.has(parts.dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.values.has(parts.dayOfWeek);
  const dayMatches =
    cron.dayOfMonth.unrestricted || cron.dayOfWeek.unrestricted
      ? dayOfMonthMatches && dayOfWeekMatches
      : dayOfMonthMatches || dayOfWeekMatches;
  return (
    cron.minute.values.has(parts.minute) &&
    cron.hour.values.has(parts.hour) &&
    cron.month.values.has(parts.month) &&
    dayMatches
  );
};

const SEARCH_LIMIT_MINUTES = 366 * 24 * 60;

export const nextCronOccurrence = (expression: string, timezone: string, after: Date): Date => {
  const cron = parseCron(expression);
  validateTimeZone(timezone);
  const formatter = formatterFor(timezone);
  const firstMinute = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (let offset = 0; offset < SEARCH_LIMIT_MINUTES; offset += 1) {
    const candidate = new Date(firstMinute + offset * 60_000);
    if (matches(cron, candidate, formatter)) return candidate;
  }
  throw new InvariantError('cron 在未来 366 天内没有可运行时间');
};
