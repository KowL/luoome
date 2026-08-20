import {
  dateInShanghai,
  type MinuteBar,
  type MinuteBarInterval,
  MinuteBarSchema,
} from '@luoome/core';

export interface MinuteBarGap {
  readonly from: Date;
  readonly to: Date;
  readonly missingBars: number;
}

export interface NormalizedMinuteBars {
  readonly date: string | null;
  readonly bars: readonly MinuteBar[];
  readonly gaps: readonly MinuteBarGap[];
  readonly outsideSessionCount: number;
  readonly mixedDateCount: number;
  readonly completeSession: boolean;
}

const intervalMinutes = (interval: MinuteBarInterval): number => Number.parseInt(interval, 10);

const shanghaiClockMinutes = (date: Date): number => {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

const sessionSegment = (date: Date): 'morning' | 'afternoon' | null => {
  const minute = shanghaiClockMinutes(date);
  if (minute >= 9 * 60 + 30 && minute <= 11 * 60 + 30) return 'morning';
  if (minute >= 13 * 60 && minute <= 15 * 60) return 'afternoon';
  return null;
};

/**
 * Provider 桶标签按上海时区的“结束时间”处理。只检测同一交易时段内的内部缺口；
 * 午休不是缺口。完整日还要求覆盖开盘首桶与 15:00 收盘桶。
 */
export const normalizeMinuteBars = (
  input: readonly MinuteBar[],
  interval: MinuteBarInterval,
): NormalizedMinuteBars => {
  const parsed = input.map((bar) => MinuteBarSchema.parse(bar));
  const latestDate = parsed.reduce<string | null>((latest, bar) => {
    const date = dateInShanghai(bar.endedAt);
    return latest === null || date > latest ? date : latest;
  }, null);
  if (latestDate === null) {
    return {
      date: null,
      bars: [],
      gaps: [],
      outsideSessionCount: 0,
      mixedDateCount: 0,
      completeSession: false,
    };
  }

  const byEnd = new Map<number, MinuteBar>();
  let outsideSessionCount = 0;
  let mixedDateCount = 0;
  for (const bar of parsed) {
    if (bar.interval !== interval || dateInShanghai(bar.endedAt) !== latestDate) {
      mixedDateCount += 1;
      continue;
    }
    if (sessionSegment(bar.endedAt) === null) {
      outsideSessionCount += 1;
      continue;
    }
    byEnd.set(bar.endedAt.getTime(), bar);
  }
  const bars = [...byEnd.values()].sort(
    (left, right) => left.endedAt.getTime() - right.endedAt.getTime(),
  );
  const stepMs = intervalMinutes(interval) * 60_000;
  const gaps: MinuteBarGap[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1];
    const current = bars[index];
    if (previous === undefined || current === undefined) continue;
    if (sessionSegment(previous.endedAt) !== sessionSegment(current.endedAt)) continue;
    const distance = current.endedAt.getTime() - previous.endedAt.getTime();
    const missingBars = Math.max(0, Math.floor(distance / stepMs) - 1);
    if (missingBars > 0) {
      gaps.push({
        from: new Date(previous.endedAt.getTime() + stepMs),
        to: new Date(current.endedAt.getTime() - stepMs),
        missingBars,
      });
    }
  }

  const first = bars[0];
  const last = bars.at(-1);
  const completeSession =
    first !== undefined &&
    last !== undefined &&
    shanghaiClockMinutes(first.endedAt) <= 9 * 60 + 30 + intervalMinutes(interval) &&
    shanghaiClockMinutes(last.endedAt) >= 15 * 60 &&
    gaps.length === 0 &&
    outsideSessionCount === 0 &&
    mixedDateCount === 0;

  return {
    date: latestDate,
    bars,
    gaps,
    outsideSessionCount,
    mixedDateCount,
    completeSession,
  };
};

export const shanghaiDayRange = (date: string): { readonly from: Date; readonly to: Date } => {
  const from = new Date(`${date}T00:00:00+08:00`);
  return { from, to: new Date(from.getTime() + 86_400_000 - 1) };
};
