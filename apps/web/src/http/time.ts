import { dateInShanghai } from '@luoome/core';

/** Asia/Shanghai 当日 00:00 的 Date（web 与 workflow 用同口径）。 */
export const startOfTodayShanghai = (now: Date): Date =>
  new Date(`${dateInShanghai(now)}T00:00:00+08:00`);
