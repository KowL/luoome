import type { AnalysisContext, RiskVetoRepository } from '@luoome/core';

/**
 * 写建议/发布结论前的**风险官否决检查**（REQ-M5-04）。
 *
 * ## 为什么抽成一个函数
 *
 * 有**四个**写入点需要它：`recordAdvice` / `recordPublication` × (memory / drizzle)。
 * 四处各写一遍，迟早有一处被漏掉或被改成不同的判据 ——
 * 那正是「加了个检查但能被绕过」的典型形态。
 *
 * ## 为什么必须传 `tx` 的读取能力而不是在事务外先查
 *
 * 事务外先查、事务内再写，中间有一个**并发窗口**：查的时候没 veto，
 * 写的时候 veto 已经落库。**分两步检查等于没检查。**
 *
 * 所以这里的 `vetos` 必须是**事务内的仓储**。
 */
export const assertNoActiveVeto = async (input: {
  readonly vetos: RiskVetoRepository;
  readonly context: AnalysisContext;
}): Promise<boolean> => {
  const active = await input.vetos.findActiveBySubject({
    accountId: input.context.accountId,
    subject: input.context.subject,
  });
  // `findActiveBySubject` 已经滤掉有 override 的记录 ⇒ 非 null 即「仍在否决中」
  return active === null;
};
