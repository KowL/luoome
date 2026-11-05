import type { AnalysisSubject } from '../entity/analysis-job.js';
import type { RiskVeto, RiskVetoOverride } from '../entity/risk-veto.js';

/**
 * 风险官否决的持久化（REQ-M5-04）。
 *
 * ## 为什么有 `findActiveBySubject` 而不是 `findByContext`
 *
 * 绑定键是 `accountId + subject`，**不是 contextId** ——
 * 有了 `findByContext` 就等于邀请调用方按 context 判，那正是要堵的绕过路径。
 */
export interface RiskVetoRepository {
  /** 记录一次否决。 */
  save(veto: RiskVeto): Promise<void>;
  /**
   * 按**绑定键**查当前有效否决（存在记录且无 override）。
   *
   * 返回值带 `override`（若有）：调用方据此判断是否放行。**不做二次查询**——
   * 那会在两次查询之间留一个并发窗口。
   */
  findActiveBySubject(input: {
    readonly accountId: string;
    readonly subject: AnalysisSubject;
  }): Promise<{ readonly veto: RiskVeto; readonly override: RiskVetoOverride | null } | null>;
  /** 按 id 读一条否决（供推翻时校验证据归属与新旧）。 */
  findVetoById(accountId: string, vetoId: string): Promise<RiskVeto | null>;
  /** 记录人工推翻。 */
  saveOverride(override: RiskVetoOverride): Promise<void>;
}
