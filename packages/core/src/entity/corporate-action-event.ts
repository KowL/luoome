import { z } from 'zod';

/**
 * 市场级原始公司行动事件 revision（设计 §6.1）。
 *
 * 与账户级 PortfolioCorporateAction 严格隔离：本实体是 append-only 的市场事实，
 * 不直接修改账户持仓、现金或 portfolio_corporate_actions。
 *
 * - dump（adjustment-factors）是完整事件候选源（含配股字段）；在线单股端点只用于
 *   现金/送转的补取与交叉核验——在线端点不返回 allotment_*，且配股除权日可能呈现为
 *   零分红零送股行（Phase 0 证据 §4），零值行必须保留，不得当噪声丢弃；
 * - sourceRecordId 由 thscode + exDate + 规范化事件内容稳定派生，不冒充上游 revision
 *   或公告 ID；同日不同现金/送转/配股事件分别保留（同日多事件），纯重复行按内容去重；
 * - 后续下载的不同内容形成新 revision（append-only），不覆盖旧行。
 */

export const CorporateActionEventRevisionSchema = z
  .object({
    stockId: z.string().min(1),
    /** 除权除息日（上海零点）。 */
    exDate: z.coerce.date(),
    /** 每股现金分红（元，税前）；无现金事件为 0。 */
    dividendPerShare: z.number().nonnegative(),
    /** 上游每股股数变动比例；无为 0，负比例原值保留，不据此生成账户动作。 */
    perShareBonus: z.number().gt(-1),
    /** 配股比例（每股可认购股数）；仅 dump 提供，在线端点恒 null。 */
    allotmentRatio: z.number().nonnegative().nullable(),
    /** 配股价格（元/股）；仅 dump 提供。 */
    allotmentPrice: z.number().nonnegative().nullable(),
    currency: z.literal('CNY'),
    source: z.literal('fuyao'),
    /** 稳定派生的事件身份（见 corporateActionSourceRecordId）。 */
    sourceRecordId: z.string().min(1),
    /** 来自 dump 时携带内容寻址；在线补取为 null。 */
    dumpId: z.string().min(1).nullable(),
    artifactSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    recordedAt: z.coerce.date(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((event, ctx) => {
    if ((event.allotmentRatio === null) !== (event.allotmentPrice === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['allotmentRatio'],
        message: 'allotmentRatio 与 allotmentPrice 必须成对存在或同时缺省',
      });
    }
    if ((event.dumpId === null) !== (event.artifactSha256 === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['dumpId'],
        message: 'dumpId 与 artifactSha256 必须成对存在或同时缺省',
      });
    }
  });
export type CorporateActionEventRevision = z.infer<typeof CorporateActionEventRevisionSchema>;

/**
 * 规范化事件内容：派生 sourceRecordId 与 contentHash 共用同一份稳定视图，
 * 数字序列化经 Number 往返（避免 1 与 1.0 的文本差异），键序固定。
 */
export const corporateActionEventContent = (
  event: Pick<
    CorporateActionEventRevision,
    | 'stockId'
    | 'exDate'
    | 'dividendPerShare'
    | 'perShareBonus'
    | 'allotmentRatio'
    | 'allotmentPrice'
    | 'currency'
    | 'source'
  >,
): string =>
  JSON.stringify({
    stockId: event.stockId,
    exDateMs: event.exDate.getTime(),
    dividendPerShare: event.dividendPerShare,
    perShareBonus: event.perShareBonus,
    allotmentRatio: event.allotmentRatio,
    allotmentPrice: event.allotmentPrice,
    currency: event.currency,
    source: event.source,
  });
