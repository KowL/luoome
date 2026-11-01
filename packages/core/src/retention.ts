/**
 * 资源保留参数的**唯一校验**（task-36 / task-37）。
 *
 * 同一类参数（`LUOOME_BACKUP_KEEP` / `LUOOME_EXPORT_KEEP` / `LUOOME_AUDIT_MAX_MB` 的份数）
 * 必须用同一条判据：**正整数，否则拒绝启动，绝不当成「0 = 全清」**。
 *
 * 一个笔误（`=0`、`=-1`、`=five`）就会把全部回滚能力或全部审计记录删光；
 * 让它在**读取参数时**就抛出，比在删除循环里依赖边界条件安全得多。
 */
export const parsePositiveInteger = (
  raw: string | undefined,
  options: {
    readonly name: string;
    readonly fallback: number;
  },
): number => {
  const text = raw?.trim();
  if (text === undefined || text === '') return options.fallback;
  if (!/^[0-9]+$/.test(text))
    throw new Error(`${options.name} 必须是正整数（当前：'${text}'）；拒绝继续，避免误清空`);
  const value = Number(text);
  if (value <= 0)
    throw new Error(`${options.name} 必须 ≥ 1（当前：${text}）；拒绝继续，避免误清空`);
  return value;
};

/** 体积阈值（MB）：正数，允许小数（测试要把阈值调到 0.001 才跑得动轮转）。 */
export const parsePositiveMegabytes = (
  raw: string | undefined,
  options: {
    readonly name: string;
    readonly fallback: number;
  },
): number => {
  const text = raw?.trim();
  if (text === undefined || text === '') return options.fallback;
  if (!/^[0-9]+(\.[0-9]+)?$/.test(text))
    throw new Error(`${options.name} 必须是正数（当前：'${text}'）；拒绝继续`);
  const value = Number(text);
  if (value <= 0) throw new Error(`${options.name} 必须 > 0（当前：${text}）；拒绝继续`);
  return value;
};
