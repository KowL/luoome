import { z } from 'zod';

/**
 * 技术指标集合（v0.2 起独立模块，ARCHITECTURE §5.1 扩字段）。
 *
 * 设计要点：
 * - `TechnicalIndicators`（同名 schema）保留 `Record<string, number>` 风格以承接
 *   v0.1 的 `computeSimpleIndicators` 输出与 `AdviceDataSnapshot.indicators` 形状。
 * - 新增 `KNOWN_INDICATOR_KEYS`：战法 DSL（v0.3）+ LLM 提示词可以枚举已知指标名，
 *   不再依赖字符串拼写，避免「vol_ratio_5_20」vs「volRatio5_20」的笔误事故。
 * - 不变量保持：每个值必须有限数（拒绝 NaN / Infinity）。
 */

/** 已知指标名集合（顺序固定，便于文档 / prompt / 战法 DSL 枚举）。 */
export const KNOWN_INDICATOR_KEYS = [
  'ma5',
  'ma10',
  'ma20',
  'ma60',
  'rsi14',
  'macdDif',
  'macdDea',
  'macdHist',
  'volMa5',
  'volMa20',
  'volRatio5_20', // (volMa5 / volMa20)，v0.2 新增，供「放量突破」战法用
  'high20', // 近 20 日最高收盘，v0.2 新增
  'low20', // 近 20 日最低收盘，v0.2 新增
] as const;

export type KnownIndicatorKey = (typeof KNOWN_INDICATOR_KEYS)[number];

/** 类型层暴露「已知指标 key 的有限类型」 + 任意额外 number 字段。 */
export interface TechnicalIndicators {
  readonly ma5?: number;
  readonly ma10?: number;
  readonly ma20?: number;
  readonly ma60?: number;
  readonly rsi14?: number;
  readonly macdDif?: number;
  readonly macdDea?: number;
  readonly macdHist?: number;
  readonly volMa5?: number;
  readonly volMa20?: number;
  readonly volRatio5_20?: number;
  readonly high20?: number;
  readonly low20?: number;
  readonly [key: string]: number | undefined;
}

export const TechnicalIndicatorsSchema = z
  .object({
    ma5: z.number().optional(),
    ma10: z.number().optional(),
    ma20: z.number().optional(),
    ma60: z.number().optional(),
    rsi14: z.number().optional(),
    macdDif: z.number().optional(),
    macdDea: z.number().optional(),
    macdHist: z.number().optional(),
    volMa5: z.number().optional(),
    volMa20: z.number().optional(),
    volRatio5_20: z.number().optional(),
    high20: z.number().optional(),
    low20: z.number().optional(),
  })
  .catchall(z.number().optional());

/**
 * 不变量断言：所有 finite 数字字段（含 catchall）必须 finite；
 * 已定义为 undefined 的字段不校验（缺省视为样本不足，与 v0.1 口径一致）。
 */
export const assertIndicatorInvariants = (s: TechnicalIndicators): void => {
  for (const [key, value] of Object.entries(s)) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`indicator "${key}" must be finite number, got ${String(value)}`);
    }
  }
};

/** 取已知指标值；未知 key 返回 undefined（不抛错，便于扩展字段读取）。 */
export const readIndicator = (s: TechnicalIndicators, key: KnownIndicatorKey): number | undefined =>
  s[key];

/** 类型守卫：字符串是否为已知指标 key。供战法 DSL 解析期校验（v0.3）。 */
export const isKnownIndicatorKey = (key: string): key is KnownIndicatorKey =>
  (KNOWN_INDICATOR_KEYS as readonly string[]).includes(key);
