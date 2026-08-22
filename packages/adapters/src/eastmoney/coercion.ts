/**
 * Eastmoney 供应商级数值 coercion helper（docs/ddd/source-pluggability-and-observation-design.md §4.2）。
 *
 * 六个领域模块原本各自重复这些 helper；此处单点维护。
 * 单位语义（×1000 价格、×100 百分数）是 Eastmoney 协议知识，属于供应商层；
 * 领域特有换算（如北向百万元 → 元）仍留在领域目录。
 */

/** 百分数 → 小数（9.98 → 0.0998）；非法值返回 undefined。 */
export const asRatio = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v / 100 : undefined;

/** 有限数值原样透传；非法值返回 undefined。 */
export const asAmount = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** 涨停池最新价 ×1000 → 元；非正 / 非法值返回 undefined。 */
export const asPrice = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v / 1000 : undefined;

/** 非空字符串原样透传；空白 / 非字符串返回 undefined。 */
export const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v : undefined;

/** 非负有限数值；非法值返回 null（调用方以 null 表达"上游未提供"）。 */
export const asNonnegativeNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/** 非负整数；非法值返回 null。 */
export const asNonnegativeInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

/** 正整数；非法值返回 undefined。 */
export const asPositiveInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
