// 草案 display 投影：按 tool 一组纯函数，从已校验的 draft input 生成卡片摘要（设计 §6.2）。
// 无专用 summarizer 的 tool 回落到最小投影（targetObject 用 tool 描述 + raw fields），不阻塞流程。

import { z } from 'zod';
import type { AgentDraftKind } from './scenarios.js';

export const DraftDisplayFieldSchema = z.object({
  name: z.string().min(1),
  value: z.unknown(),
  source: z.enum(['user', 'default', 'inferred']),
});

export const DraftDisplaySchema = z.object({
  /** 将创建/修改的对象描述，如「Watchlist『超跌反弹』」 */
  targetObject: z.string().min(1),
  fields: z.array(DraftDisplayFieldSchema).max(50),
  /** 用户意图中当前不支持、已被丢弃的条件 */
  unsupported: z.array(z.string().min(1)).max(20),
  /** 有歧义、按默认值处理的点 */
  ambiguous: z.array(z.string().min(1)).max(20),
});

export type DraftDisplay = z.infer<typeof DraftDisplaySchema>;
export type DraftDisplayField = z.infer<typeof DraftDisplayFieldSchema>;

type ParsedInput = Record<string, unknown>;

const asRecord = (value: unknown): ParsedInput =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as ParsedInput)
    : {};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * source 判定：出现在模型原始 input 中的字段标 'user'；schema 校验补全（raw 中缺失）
 * 的标 'default'；'inferred' 只留给 summarizer 能明确推断的字段。
 */
const field = (
  raw: ParsedInput,
  parsed: ParsedInput,
  key: string,
  name: string,
  value?: unknown,
): DraftDisplayField => ({
  name,
  value: value ?? parsed[key],
  source: key in raw ? 'user' : 'default',
});

const genericFields = (raw: ParsedInput, parsed: ParsedInput): DraftDisplayField[] =>
  Object.keys(parsed).map((key) => field(raw, parsed, key, key));

interface DraftSummarySpec {
  readonly targetObject: string;
  readonly fields?: readonly DraftDisplayField[];
  readonly unsupported?: readonly string[];
  readonly ambiguous?: readonly string[];
}

type DraftSummarizer = (raw: ParsedInput, parsed: ParsedInput) => DraftSummarySpec;

const SUMMARIZERS: Readonly<Record<string, DraftSummarizer>> = {
  create_strategy: (raw, parsed) => ({
    targetObject: `Strategy「${text(parsed.name)}」`,
    fields: [
      field(raw, parsed, 'name', '名称'),
      field(raw, parsed, 'description', '说明'),
      ...(parsed.copyFromStrategyId !== undefined
        ? [field(raw, parsed, 'copyFromStrategyId', '复制自 Strategy')]
        : []),
    ],
  }),
  create_watchlist: (raw, parsed) => ({
    targetObject: `Watchlist「${text(parsed.name)}」`,
    fields: [
      field(raw, parsed, 'name', '名称'),
      field(raw, parsed, 'kind', '类型'),
      field(raw, parsed, 'membershipPolicy', '维护方式'),
      field(raw, parsed, 'enabled', '启用'),
    ],
  }),
  add_watchlist_members: (raw, parsed) => {
    const members = Array.isArray(parsed.members) ? parsed.members : [];
    const stockIds = members
      .map((item) => text(asRecord(item).stockId))
      .filter((id) => id.length > 0);
    return {
      targetObject: `Watchlist ${text(parsed.watchlistId)}（新增 ${members.length} 名成员）`,
      fields: [
        field(raw, parsed, 'watchlistId', '目标 Watchlist'),
        { name: '成员', value: stockIds, source: 'user' as const },
      ],
    };
  },
  create_alert_plan: (raw, parsed) => ({
    targetObject: `AlertPlan「${text(parsed.name)}」`,
    fields: [
      field(raw, parsed, 'name', '名称'),
      field(raw, parsed, 'watchlistId', '关联 Watchlist'),
      field(
        raw,
        parsed,
        'rules',
        '规则数',
        Array.isArray(parsed.rules) ? parsed.rules.length : undefined,
      ),
    ],
  }),
  create_research_topic: (raw, parsed) => ({
    targetObject: `研究主题「${text(parsed.title)}」`,
    fields: [
      field(raw, parsed, 'title', '标题'),
      field(raw, parsed, 'kind', '类型'),
      ...(parsed.summary !== undefined ? [field(raw, parsed, 'summary', '摘要')] : []),
      field(raw, parsed, 'tags', '标签'),
    ],
  }),
  analyze_stock: (raw, parsed) => ({
    targetObject: `个股 Advice（${text(parsed.stockId)}）`,
    fields: [
      field(raw, parsed, 'stockId', '股票'),
      ...(parsed.notes !== undefined ? [field(raw, parsed, 'notes', '备注')] : []),
    ],
  }),
  analyze_position: (raw, parsed) => ({
    targetObject: `持仓 Advice（${text(parsed.holdingId)}）`,
    fields: [field(raw, parsed, 'holdingId', '持仓')],
  }),
  market_outlook: (raw, parsed) => {
    const theme = text(parsed.theme);
    return {
      targetObject: theme.length > 0 ? `市场观点 Advice（${theme}）` : '市场观点 Advice（全市场）',
      fields: [
        ...(parsed.theme !== undefined ? [field(raw, parsed, 'theme', '板块/主题')] : []),
        ...(parsed.notes !== undefined ? [field(raw, parsed, 'notes', '备注')] : []),
      ],
      ambiguous: theme.length > 0 ? [] : ['未指定板块或主题，将按全市场评估'],
    };
  },
};

export interface SummarizeDraftArgs {
  readonly tool: string;
  readonly kind: AgentDraftKind;
  /** 模型提交的原始 input（未做 schema 默认值补全） */
  readonly input: unknown;
  /** inputSchema 校验后的 input（含默认值） */
  readonly parsed: ParsedInput;
  /** tool 描述，用于回落投影的 targetObject */
  readonly description: string;
}

export const summarizeDraft = (args: SummarizeDraftArgs): DraftDisplay => {
  const raw = asRecord(args.input);
  const summarizer = SUMMARIZERS[args.tool];
  const spec = summarizer?.(raw, args.parsed);
  return {
    targetObject: spec?.targetObject ?? args.description,
    fields: [...(spec?.fields ?? genericFields(raw, args.parsed))],
    unsupported: [...(spec?.unsupported ?? [])],
    ambiguous: [...(spec?.ambiguous ?? [])],
  };
};
