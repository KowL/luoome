import { type ExternalFactDraft, NewsItemSchema, type ToolContext } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput } from '../define-tool.js';

/**
 * 把**已抓取**的外部事实落库（REQ-M3-16 / S5）。
 *
 * 为什么单独一个工具而不是让 `fetch_news` 自己写库：
 * `fetch_news` 的 `sideEffect: 'external'` 是既有契约（market surface 只收 external），
 * 改成 write 会破坏 `assertSurfaceSelection` 的分面校验。所以拆成「抓取（external）→
 * 落库（write）」两步，与 `sync_daily_bars` / `sync_quotes` 同族的「同步→落库」形态一致。
 *
 * **强制点不在这里**：本工具只负责生成稳定 id 并 upsert；「未落库不得进 Advice」由
 * `checkExternalFactPersistence`（L2）在两条写 Advice 的路径上把关。本工具是**业务事实**
 * 的写入口，表可以导出；凭据永远在 `$LUOOME_HOME/.env`（0600），不进任何表。
 */

const DAY_MS = 86_400_000;
/** 落库窗口上限：防止一次传入超长历史（保留幂等 upsert 的语义边界）。 */
const MAX_LOOKBACK_DAYS = 3_660;

export const NewsFactDraftSchema = z
  .object({
    /** 上游新闻 id（`NewsItem.id`）——它是稳定 id 的 subjectKey。 */
    id: z.string().min(1),
    title: z.string().min(1),
    summary: z.string(),
    category: z.string().min(1),
    /** 来源媒体（`NewsItem.source`）。 */
    media: z.string(),
    /** 发布时间（= observedAt；缺了就拒绝落库，不拿 fetchedAt 顶替）。 */
    publishedAt: z.coerce.date(),
    url: z.string(),
    /** 数据来源 provider（`NewsList.source`，如 eastmoney）。 */
    source: z.string().min(1),
  })
  .strict();

export const PersistExternalFactsInput = z
  .object({
    /** 本批事实共用的 provider 标识；逐条 `source` 覆盖它。 */
    source: z.string().min(1).max(100).optional(),
    facts: z.array(NewsFactDraftSchema).min(1).max(500),
  })
  .strict();

export const PersistExternalFactsOutput = z
  .object({
    schemaVersion: z.literal(1),
    inserted: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    /** 缺 `observedAt` 等必填项的事实：**不落库**，逐条说明原因。 */
    rejected: z.array(
      z.object({ subjectKey: z.string().min(1), reason: z.string().min(1) }).strict(),
    ),
    facts: z.array(z.object({ id: z.string().min(1), contentHash: z.string().min(1) }).strict()),
    /** = max(observedAt)；没有落库任何事实时缺席。 */
    dataAsOf: z.coerce.date().optional(),
  })
  .strict();

/**
 * 落库前剥离 URL 里的凭据类查询参数。
 *
 * 上游新闻源偶尔把 token 放在 `?token=` / `?key=` 里；`payload` 是会被导出、也会被报告
 * 引用的业务事实，带凭据等于把密钥写进迁移包（`SECURITY.md` 的「不入 SQLite」）。
 */
export const stripCredentialQuery = (url: string): string => {
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    let touched = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(token|key|api_?key|access_?token|secret|sig|signature)$/i.test(key)) {
        parsed.searchParams.delete(key);
        touched = true;
      }
    }
    return touched ? parsed.toString() : url;
  } catch {
    return url;
  }
};

const toDraft = (
  input: z.infer<typeof NewsFactDraftSchema>,
): ExternalFactDraft | { reason: string } => {
  if (!Number.isFinite(input.publishedAt.getTime())) return { reason: 'observedAt 不是合法时间' };
  const item = NewsItemSchema.safeParse({
    id: input.id,
    title: input.title,
    summary: input.summary,
    category: input.category,
    source: input.media,
    publishedAt: input.publishedAt,
    url: stripCredentialQuery(input.url),
  });
  if (!item.success)
    return { reason: `事实字段不合法：${item.error.issues[0]?.message ?? 'unknown'}` };
  return {
    kind: 'news',
    subjectKey: input.id,
    category: input.category,
    observedAt: input.publishedAt,
    source: input.source,
    provenance: {
      provider: input.source,
      observedAt: input.publishedAt,
      fetchedAt: input.publishedAt,
      freshness: 'fresh',
    },
    payload: {
      title: item.data.title,
      summary: item.data.summary,
      category: item.data.category,
      media: item.data.source,
      url: item.data.url,
    },
  };
};

export const persistExternalFactsTool = defineTool({
  name: 'persist_external_facts',
  description:
    '把已抓取的外部市场事实（当前仅 news）幂等落库：同一条事实重抓命中同一 id，' +
    '上游更正正文时 id 不变、事实更新并留 revisedAt；缺 observedAt 的事实逐条拒绝而不落库；' +
    '落库后 Advice 才能引用（未落库的 extfact 会被拒）。只写本地事实表，不访问外部服务',
  sideEffect: 'write',
  input: PersistExternalFactsInput,
  output: PersistExternalFactsOutput,
  handler: async (input, ctx: ToolContext) => {
    const now = ctx.clock();
    const counted = { inserted: 0, updated: 0, unchanged: 0 };
    const rejected: { subjectKey: string; reason: string }[] = [];
    const facts: { id: string; contentHash: string }[] = [];
    const observed: Date[] = [];

    for (const entry of input.facts) {
      // 逐条 source：批级 source 作兜底，条目自带优先。
      const draft = toDraft({
        ...entry,
        source: entry.source.length > 0 ? entry.source : (input.source ?? ''),
      });
      if ('reason' in draft) {
        rejected.push({ subjectKey: entry.id, reason: draft.reason });
        continue;
      }
      if (input.source !== undefined && draft.source.length === 0) {
        rejected.push({ subjectKey: entry.id, reason: '缺少 source' });
        continue;
      }
      if (now.getTime() - draft.observedAt.getTime() > MAX_LOOKBACK_DAYS * DAY_MS) {
        rejected.push({ subjectKey: entry.id, reason: 'observedAt 超出可落库窗口' });
        continue;
      }
      const { outcome, fact } = await ctx.repos.externalMarketFact.upsert({ draft, now });
      counted[outcome] += 1;
      facts.push({ id: fact.id, contentHash: fact.contentHash });
      observed.push(fact.observedAt);
    }

    if (facts.length === 0 && rejected.length > 0)
      return errInvalidInput(`没有可落库的事实：${rejected.map((item) => item.reason).join('；')}`);

    return {
      schemaVersion: 1 as const,
      ...counted,
      rejected,
      facts,
      ...(observed.length === 0
        ? {}
        : {
            dataAsOf: new Date(Math.max(...observed.map((item) => item.getTime()))),
          }),
    };
  },
});
