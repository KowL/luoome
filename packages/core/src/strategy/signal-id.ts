/**
 * StrategySignal 的 64 位整数 id。
 *
 * 布局是 snowflake 的 41 位毫秒时间戳 + 22 位序列（单进程本地应用不划分 workerId）：
 * `(nowMs - EPOCH) << 22 | seq`。这样 id 单调递增、按时间聚集，且只占 18–19 个字符，
 * 不再是过去那种 `${runId}:${ruleId}:${stockId}:${iso}` 的 100 字符拼接串——后者会被
 * 复制进 signal_observations.source_id（数百万行），是当时最大的单笔存储开销。
 *
 * 对外一律用十进制字符串：JS number 只有 53 位精度，直接当 number 传会在 JSON 和工具
 * 边界静默丢位。时钟回拨时沿用上一毫秒；同一毫秒序列用尽时借用下一毫秒，保证单进程内
 * 唯一且单调。
 */
const EPOCH_MS = Date.UTC(2025, 0, 1);
const SEQUENCE_BITS = 22n;
const SEQUENCE_MASK = (1n << SEQUENCE_BITS) - 1n;

let lastMs = 0n;
let sequence = 0n;

export const nextStrategySignalId = (nowMs: number = Date.now()): string => {
  let ms = BigInt(Math.trunc(nowMs));
  if (ms < lastMs) ms = lastMs;
  if (ms === lastMs) {
    sequence += 1n;
    if (sequence > SEQUENCE_MASK) {
      ms += 1n;
      sequence = 0n;
    }
  } else {
    sequence = 0n;
  }
  lastMs = ms;
  return (((ms - BigInt(EPOCH_MS)) << SEQUENCE_BITS) | sequence).toString(10);
};

/** 迁移用：按信号自身的 ts 生成同布局 id，同一毫秒内由调用方给定序号。 */
export const strategySignalIdAt = (tsMs: number, sequenceInMs: number): string =>
  (
    ((BigInt(Math.trunc(tsMs)) - BigInt(EPOCH_MS)) << SEQUENCE_BITS) |
    (BigInt(sequenceInMs) & SEQUENCE_MASK)
  ).toString(10);
