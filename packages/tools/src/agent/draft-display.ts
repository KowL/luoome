// 草案 display 投影：按 tool 一组纯函数，从已校验的 draft input 生成卡片摘要（设计 §6.2）。
// 无专用 summarizer 的 tool 回落到最小投影（targetObject 用 tool 描述 + raw fields），不阻塞流程。

import {
  cashImpactOfCashFlow,
  cashImpactOfHoldingChange,
  money,
  type PortfolioCashFlowKind,
} from '@luoome/core';
import { z } from 'zod';
import type { AddHoldingInput } from '../tools/add-holding.js';
import type { CreateAccountInput } from '../tools/create-account.js';
import type { CreatePortfolioCashFlowInput } from '../tools/portfolio-performance.js';
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

const knownness = (raw: ParsedInput, key: string): DraftDisplayField['value'] =>
  key in raw ? '已知' : '未知';

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

const CASH_FLOW_LABELS: Readonly<Record<PortfolioCashFlowKind, string>> = {
  deposit: '入金',
  withdrawal: '出金',
  dividend: '分红',
  fee: '费用',
  tax: '税费',
  'transfer-in': '转入',
  'transfer-out': '转出',
};

const SUMMARIZERS: Readonly<Record<string, DraftSummarizer>> = {
  create_account: (raw, parsed) => {
    const input = parsed as z.infer<typeof CreateAccountInput>;
    return {
      targetObject: `投资账本账户「${input.name}」`,
      fields: [
        ...(input.id === undefined ? [] : [field(raw, parsed, 'id', '账户 ID')]),
        field(raw, parsed, 'name', '名称'),
        field(raw, parsed, 'currency', '币种'),
        field(raw, parsed, 'initialCapital', '初始本金'),
        { name: '初始现金余额', value: money(input.initialCapital), source: 'inferred' },
        {
          name: '操作性质',
          value: '创建本地投资账本记录，不会在券商开户或转账',
          source: 'default',
        },
      ],
    };
  },
  add_holding: (raw, parsed) => {
    const input = parsed as z.infer<typeof AddHoldingInput>;
    return {
      targetObject: `登记持仓「${input.stockName ?? input.stockId}」`,
      fields: [
        field(raw, parsed, 'accountId', '账户', input.accountId ?? '当前默认账户'),
        field(raw, parsed, 'stockId', '股票'),
        ...(input.stockName === undefined ? [] : [field(raw, parsed, 'stockName', '股票名称')]),
        field(raw, parsed, 'quantity', '持仓数量（股）'),
        field(raw, parsed, 'avgCost', '平均成本价（账户币种）'),
        field(
          raw,
          parsed,
          'availableQuantity',
          '可卖数量（股）',
          input.availableQuantity ?? input.quantity,
        ),
        field(raw, parsed, 'openedAt', '建仓时间', input.openedAt ?? '确认执行时的当前时间'),
        {
          name: '现金变化（账户币种）',
          value: cashImpactOfHoldingChange(null, {
            quantity: input.quantity,
            avgCost: money(input.avgCost),
            closedAt: null,
          }),
          source: 'inferred',
        },
        {
          name: '操作性质',
          value: '登记已有持仓并扣减成本；现金不足时拒绝，不会买入股票',
          source: 'default',
        },
      ],
      ambiguous: [
        ...(input.accountId === undefined ? ['未显式指定账户，将使用当前默认账户'] : []),
        ...(input.availableQuantity === undefined
          ? ['未指定可卖数量，将全部记为可卖；请核对卖出限制']
          : []),
        ...(input.openedAt === undefined ? ['未指定建仓时间，将记录为确认执行时间'] : []),
      ],
    };
  },
  update_holding: (raw, parsed) => ({
    targetObject: `纠错持仓「${text(parsed.holdingId)}」`,
    fields: [
      field(raw, parsed, 'holdingId', '持仓 ID'),
      ...(parsed.quantity === undefined
        ? []
        : [field(raw, parsed, 'quantity', '修正后数量（股）')]),
      ...(parsed.availableQuantity === undefined
        ? []
        : [field(raw, parsed, 'availableQuantity', '修正后可卖数量（股）')]),
      ...(parsed.avgCost === undefined
        ? []
        : [field(raw, parsed, 'avgCost', '修正后成本价（账户币种）')]),
      {
        name: '现金影响',
        value: '按原持仓成本减修正后成本增减现金；仅改可卖数量不改变现金，现金不足时拒绝',
        source: 'default',
      },
      { name: '操作性质', value: '纠正账本记录，不会买卖股票', source: 'default' },
    ],
    ambiguous: ['现金变化金额需结合当前持仓核对；本草案未包含原持仓成本'],
  }),
  close_holding: (raw, parsed) => ({
    targetObject: `关闭持仓记录「${text(parsed.holdingId)}」`,
    fields: [
      field(raw, parsed, 'holdingId', '持仓 ID'),
      {
        name: '现金影响',
        value: '将当前持仓成本回补到账户现金；不按成交价计算，不记录实际卖出收益',
        source: 'default',
      },
      {
        name: '操作性质',
        value: '标记账本持仓为已关闭并保留历史，不会卖出股票',
        source: 'default',
      },
    ],
    ambiguous: ['现金回补金额需结合当前持仓核对；本草案未包含原持仓成本'],
  }),
  create_portfolio_cash_flow: (raw, parsed) => {
    const input = parsed as z.infer<typeof CreatePortfolioCashFlowInput>;
    return {
      targetObject: `账户资金流水「${CASH_FLOW_LABELS[input.kind]}」`,
      fields: [
        field(raw, parsed, 'accountId', '账户'),
        field(raw, parsed, 'kind', '流水类型', CASH_FLOW_LABELS[input.kind]),
        field(raw, parsed, 'amount', '金额'),
        field(raw, parsed, 'currency', '币种'),
        field(raw, parsed, 'occurredAt', '发生时间'),
        field(raw, parsed, 'source', '来源'),
        ...(input.stockId === undefined ? [] : [field(raw, parsed, 'stockId', '关联股票')]),
        ...(input.note === undefined ? [] : [field(raw, parsed, 'note', '备注')]),
        { name: '现金变化', value: cashImpactOfCashFlow(input), source: 'inferred' },
        {
          name: '操作性质',
          value: '记录已发生的资金变化并更新账本现金；不会发起实际转账',
          source: 'default',
        },
      ],
    };
  },
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
  create_research_hypothesis_version: (raw, parsed) => ({
    targetObject: `研究假设版本「${text(parsed.topicId)}」`,
    fields: [
      field(raw, parsed, 'topicId', 'Topic'),
      field(raw, parsed, 'documentId', 'Document'),
      field(raw, parsed, 'documentContentHash', '内容 Hash'),
      field(raw, parsed, 'summary', '摘要'),
    ],
  }),
  record_advice_outcome: (raw, parsed) => ({
    targetObject: `Advice 结果「${text(parsed.adviceId)}」`,
    fields: [
      field(raw, parsed, 'adviceId', 'Advice'),
      field(raw, parsed, 'outcome', '结果'),
      field(raw, parsed, 'tradeIds', '交易 IDs'),
      {
        name: '盈亏已知性',
        value: knownness(raw, 'pnl'),
        source: 'pnl' in raw ? ('user' as const) : ('default' as const),
      },
      field(raw, parsed, 'pnl', '实际盈亏'),
      {
        name: '基准盈亏已知性',
        value: knownness(raw, 'benchmarkPnl'),
        source: 'benchmarkPnl' in raw ? ('user' as const) : ('default' as const),
      },
      ...(parsed.benchmarkPnl === undefined
        ? []
        : [field(raw, parsed, 'benchmarkPnl', '基准盈亏')]),
      ...(parsed.holdingHours === undefined
        ? []
        : [field(raw, parsed, 'holdingHours', '持有时长（小时）')]),
      ...(parsed.notes === undefined ? [] : [field(raw, parsed, 'notes', '复盘备注')]),
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
