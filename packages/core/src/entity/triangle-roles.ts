import { z } from 'zod';

/**
 * 多空风控三角的**角色契约**（REQ-M4-02）。
 *
 * ## 为什么证据只能用 fact id 引用
 *
 * 四个角色共享同一个 `AnalysisContext`（`contextId` + `factIds`）。
 * 如果角色之间传自由文本当「证据」，那就等于**没有共享上下文**——
 * 每方各说各话，事后也无法把分歧点定位回具体 fact。
 *
 * 所以这里**结构性地**禁止：所有证据字段的类型都是 `factIds: string[]`，
 * 没有任何 `evidence: string[]` 之类的入口。**这比文档约定可靠**——
 * schema 定义在那里，填字符串就直接被 zod 拒绝。
 *
 * ## 为什么不复用 `Advice` 的字段名（action / side / direction）
 *
 * 角色输出不是建议。尤其裁决官**没有 buy/sell 权限**（PRD 明文），
 * 若沿用一个含 `action` 的形状，很容易被下游当成建议直接投递。
 */

/** 可证伪条件：必须能指向「什么事实出现了，这条就错了」。 */
export const FalsifiableConditionSchema = z
  .object({
    /** 条件的人话描述（允许文本：它本身不是证据，是待验证的断言）。 */
    statement: z.string().min(1).max(500),
    /** 该条件依赖的 fact id；为空表示「这条无法核对」，会被计入缺口。 */
    factIds: z.array(z.string().min(1)).default([]),
    /** 可核对的时点（到什么时候能判定真假）。 */
    checkBy: z.coerce.date().nullable().default(null),
  })
  .strict();
export type FalsifiableCondition = z.infer<typeof FalsifiableConditionSchema>;

/** 多头角色：支持证据 + **至少 3 条**可证伪条件（PRD 明文）。 */
export const BullRationaleSchema = z
  .object({
    role: z.literal('bull'),
    /** 引用的 fact id——**只有 id，没有自由文本证据**。 */
    factIds: z.array(z.string().min(1)).min(1),
    thesis: z.string().min(1).max(2000),
    falsifiable: z.array(FalsifiableConditionSchema).min(3),
  })
  .strict();
export type BullRationale = z.infer<typeof BullRationaleSchema>;

/** 空头角色：专职证伪——每条反驳都必须指向 fact。 */
export const BearRationaleSchema = z
  .object({
    role: z.literal('bear'),
    factIds: z.array(z.string().min(1)).min(1),
    thesis: z.string().min(1).max(2000),
    /** 针对多头每条可证伪条件的反驳；可以少于多头条数（有的证伪不成立）。 */
    refutations: z
      .array(
        z
          .object({
            /** 被反驳的那条多头条件的序号（0-based）。 */
            targetIndex: z.number().int().nonnegative(),
            /** 反驳依据的 fact id。 */
            factIds: z.array(z.string().min(1)).min(1),
            statement: z.string().min(1).max(500),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type BearRationale = z.infer<typeof BearRationaleSchema>;

/**
 * 裁决官：**只核对与并列，无 buy/sell 权限**。
 *
 * 这里的 schema **刻意不含** `action` / `side` / `direction` / `recommendation`
 * 之类的字段——不是「约定不填」，是**根本没有这个位置**。
 * 守卫（`triangle-roles.guard.test.ts`）会断言这一点。
 */
export const JudgeVerdictSchema = z
  .object({
    role: z.literal('judge'),
    /**
     * 分歧点：必须定位到具体 fact id（PRD：分歧点定位到具体 fact id）。
     */
    disagreementPoints: z
      .array(
        z
          .object({
            factIds: z.array(z.string().min(1)).min(1),
            description: z.string().min(1).max(500),
            /** 多头与空头在这个 fact 上分别怎么读的（并列，不裁决对错）。 */
            bullReading: z.string().min(1).max(500),
            bearReading: z.string().min(1).max(500),
          })
          .strict(),
      )
      .default([]),
    /** 共识点：双方都认同的事实引用。 */
    agreements: z
      .array(
        z
          .object({ factIds: z.array(z.string().min(1)).min(1), statement: z.string().min(1) })
          .strict(),
      )
      .default([]),
    /**
     * **一等公民**：因事实缺口而不下结论。
     * `need-more-data` 是**正常输出**，不是 error（PRD 明文）。
     */
    status: z.enum(['concluded', 'need-more-data']),
    /** `need-more-data` 时必填：缺哪些 fact、为什么缺。 */
    blockers: z
      .array(
        z
          .object({
            factId: z.string().min(1).nullable(),
            reason: z.string().min(1).max(500),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/** 风险官：`pass` / `veto(reason+evidence)` / `need-more-data`。 */
export const RiskOfficerVerdictSchema = z
  .discriminatedUnion('status', [
    z.object({ role: z.literal('risk-officer'), status: z.literal('pass') }).strict(),
    z
      .object({
        role: z.literal('risk-officer'),
        status: z.literal('veto'),
        reason: z.string().min(1).max(1000),
        /** 否决依据的 fact id——**不允许只有理由没有依据**。 */
        factIds: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    z
      .object({
        role: z.literal('risk-officer'),
        status: z.literal('need-more-data'),
        /** 缺哪些 fact。 */
        factIds: z.array(z.string().min(1)).default([]),
        reason: z.string().min(1).max(1000),
      })
      .strict(),
  ])
  .describe('pass | veto(reason+evidence) | need-more-data');
export type RiskOfficerVerdict = z.infer<typeof RiskOfficerVerdictSchema>;

/** 四角色集合。 */
export const TriangleRolesSchema = z
  .object({
    bull: BullRationaleSchema,
    bear: BearRationaleSchema,
    judge: JudgeVerdictSchema,
    riskOfficer: RiskOfficerVerdictSchema,
  })
  .strict();
export type TriangleRoles = z.infer<typeof TriangleRolesSchema>;
