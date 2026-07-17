/**
 * 确定性伪随机工具（mock 专用）。
 * 同一输入永远得到同一输出：不依赖 Date.now / Math.random，
 * 保证 MockMarketAdapter / MockLLMAdapter 的可重复性。
 */

/** FNV-1a 32-bit 字符串哈希。 */
export const hashString = (input: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/** mulberry32 PRNG：给定种子返回 [0, 1) 的确定性序列。 */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** 从非空数组中按种子确定性取一个元素（规避 noUncheckedIndexedAccess）。 */
export const pickDeterministic = <T>(items: readonly T[], seed: number): T => {
  if (items.length === 0) {
    throw new Error('pickDeterministic: items must not be empty');
  }
  const item = items[seed % items.length];
  if (item === undefined) {
    throw new Error('pickDeterministic: index out of range');
  }
  return item;
};

/** 默认 mock 时钟：固定到 2026-07-17 15:00（UTC+8，A 股收盘）。可注入替换。 */
export const DEFAULT_MOCK_NOW = new Date('2026-07-17T07:00:00.000Z');

export const defaultMockClock = (): Date => new Date(DEFAULT_MOCK_NOW.getTime());
