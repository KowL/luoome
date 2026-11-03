import { z } from 'zod';

import { AnalysisSubjectSchema } from './analysis-job.js';

/**
 * 风险官**否决**（REQ-M5-04）。
 *
 * ## 为什么必须持久化
 *
 * M4-02 的 `RiskOfficerVerdict` 只是**角色输出**——它存在于一次调用的返回值里。
 * 那意味着：**重试一次、换个 context，否决就消失了**。
 * 「否决后主 agent 无法继续写建议」在那种形态下**根本无法成立**。
 *
 * ## 为什么绑定 `accountId + subject`，不绑 `contextId`
 *
 * 绑 `contextId` 在结构上**挡不住**「重新取一个 context 绕过否决」：
 * 新 context 是新 `contextId`，旧 veto 不跟过去 —— 于是否决被一次「重新取数」消解。
 *
 * 绑 `accountId + subject` 才挡得住。代价是更严：同一标的的否决会跨 context 生效。
 * **这个严格度由 override 路径兜底**（见 `RiskVetoOverrideSchema`），不是死锁。
 *
 * ## 判定规则（简单且可解释）
 *
 * > **veto 有效 = 存在记录 且 无 override。**
 *
 * **没有「自动过期」** —— 会自己消失的否决不是否决。
 * 解除只有两条路：① 人工 override ② 一次完整的新分析结果覆盖。
 */
export const RiskVetoSchema = z
  .object({
    id: z.string().min(1),
    accountId: z.string().min(1),
    /** 绑定键的另一半：`subject.kind + subject.id`。**不绑 contextId**。 */
    subject: AnalysisSubjectSchema,
    /** 否决理由（人话）。 */
    reason: z.string().trim().min(1).max(1000),
    /**
     * 依据的事实 id。
     *
     * ⚠️ **非空不等于有效**：还要验证这些 id **确实属于当时的事实快照**
     * （见 `vetoEvidenceBelongsToContext`）。否则模型可以编一串 id。
     */
    factIds: z.array(z.string().min(1)).min(1),
    /** 做出否决时所依据的 context（仅用于证据归属校验与审计，**不是绑定键**）。 */
    contextId: z.string().min(1),
    createdAt: z.coerce.date(),
  })
  .strict();
export type RiskVeto = z.infer<typeof RiskVetoSchema>;

/**
 * 否决的证据必须**真的属于那个上下文**。
 *
 * `factIds` 非空是不够的——模型可以凭空写一串 id。
 * 这里要求每一个都能在 `context.factIds` 里找到。
 */
export const vetoEvidenceBelongsToContext = (input: {
  readonly vetoFactIds: readonly string[];
  readonly contextFactIds: readonly string[];
}): boolean => {
  const known = new Set(input.contextFactIds);
  return input.vetoFactIds.length > 0 && input.vetoFactIds.every((id) => known.has(id));
};

/** 建议写入被否决时的拒绝原因（`AnalysisRecordResult.reason` 的新成员）。 */
export const RISK_VETO_REJECTION = 'risk_officer_veto' as const;

/**
 * 人工推翻否决（REQ-M5-04「升级路径」）。
 *
 * ## 两条硬约束
 *
 * 1. **`overriddenBy` 是枚举不是自由字符串** —— 自由字符串会让「agent 冒充 user」有缝可钻。
 *   现在只有 `user`；将来若有管理员角色再扩。
 * 2. **必须给出新证据**（`newFactIds` 非空）——
 *    「我认为它错了」不是推翻理由，**「我看到了它没看到的事实」才是**。
 *    这与项目铁律「结论要有事实依据」一致。
 */
export const RiskVetoOverrideSchema = z
  .object({
    id: z.string().min(1),
    /** 被推翻的那次否决。 */
    vetoId: z.string().min(1),
    /** **只能是 `user`**：不接受 agent 自述的身份。 */
    overriddenBy: z.enum(['user']),
    /** Legacy overrides lack these fields; new human overrides always record both. */
    actorUserId: z.string().min(1).optional(),
    evidenceContextId: z.string().min(1).optional(),
    reason: z.string().trim().min(1).max(1000),
    /**
     * **新**证据：不能只是复述被否决时的 factIds。
     * 由 `overrideCarriesNewEvidence` 校验。
     */
    newFactIds: z.array(z.string().min(1)).min(1),
    overriddenAt: z.coerce.date(),
  })
  .strict();
export type RiskVetoOverride = z.infer<typeof RiskVetoOverrideSchema>;

/**
 * 推翻必须带**当次否决没有**的证据。
 *
 * 只写理由不算推翻 —— 那只是「我觉得它错了」。
 */
export const overrideCarriesNewEvidence = (input: {
  readonly vetoFactIds: readonly string[];
  readonly newFactIds: readonly string[];
}): boolean => {
  const seen = new Set(input.vetoFactIds);
  return input.newFactIds.length > 0 && input.newFactIds.some((id) => !seen.has(id));
};
