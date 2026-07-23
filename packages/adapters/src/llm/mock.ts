import type {
  AdviceDecision,
  AdviceHorizon,
  AdviceReasoning,
  LLMGenerateRequest,
} from '@luoome/core';

import { hashString, mulberry32, pickDeterministic } from '../internal/deterministic.js';
import type { LLMAdapter, LLMGenerateResult } from './types.js';

/** system prompt 标识（ARCHITECTURE §6.3 的两种 advice 场景）。 */
export const MOCK_LLM_SYSTEM_ANALYZE_STOCK = 'analyze_stock';
export const MOCK_LLM_SYSTEM_ANALYZE_POSITION = 'analyze_position';
export const MOCK_LLM_SYSTEM_MARKET_OUTLOOK = 'market_outlook';
export const MOCK_LLM_SYSTEM_SCORE_SIGNALS = 'score_signals';
export const MOCK_LLM_SYSTEM_RESOLVE_LLM_GROUP = 'resolve_llm_group';
export const MOCK_LLM_SYSTEM_CHAT_PLAN = 'chat_plan';
export const MOCK_LLM_SYSTEM_CHAT_REPLY = 'chat_reply';

/**
 * web chat 测试注入前缀（docs/web-chat-design.md §6）：
 * message 以该前缀开头时，其余部分按 JSON parse 为 Pass 1 plan；
 * plan 可额外携带 `pass2Reply` 字段作为 Pass 2（chat_reply）的输出
 * （plan schema safeParse 会 strip 掉该未知字段，不影响 Pass 1）。
 * 另：plan.reply 中的 `${historyLength}` 会被替换为 data.history 实际长度
 * （服务端截断行为的可观测探针）。
 */
export const MOCK_CHAT_FIXTURE_PREFIX = 'chat-fixture:';

/** MockLLMAdapter 输出的结构化分析结果（analyze_stock / analyze_position 共用形状）。 */
export interface MockAnalysisOutput {
  readonly decision: AdviceDecision;
  readonly confidence: number;
  readonly horizon: AdviceHorizon;
  readonly reasoning: AdviceReasoning;
  readonly risks: readonly string[];
}

type MockMode =
  | 'analyze_stock'
  | 'analyze_position'
  | 'market_outlook'
  | 'score_signals'
  | 'resolve_llm_group'
  | 'chat_plan'
  | 'chat_reply'
  | 'generic';

/** 仅依赖 safeParse 的最小 schema 投影（zod schema 天然满足）。 */
interface SchemaLike {
  safeParse(input: unknown): { success: boolean; data?: unknown; error?: unknown };
}

const isSchemaLike = (schema: unknown): schema is SchemaLike =>
  typeof schema === 'object' &&
  schema !== null &&
  typeof (schema as { safeParse?: unknown }).safeParse === 'function';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

/**
 * mock 无法在类型层构造任意 T：正确性由 schema safeParse 在运行时保证
 * （ARCHITECTURE §6.3 schema-constrained decoding），这里经 unknown 断言。
 */
const asGenerateResult = <T>(data: unknown, raw: string): LLMGenerateResult<T> => {
  // 数组：保留为数组，并把 raw 作为属性挂在数组上（JS 允许 array.x = ...）
  if (Array.isArray(data)) {
    const arr = [...data] as unknown as LLMGenerateResult<T>;
    (arr as unknown as { raw: string }).raw = raw;
    return arr;
  }
  if (typeof data === 'object' && data !== null) {
    return { ...(data as object), raw } as unknown as LLMGenerateResult<T>;
  }
  return { raw } as unknown as LLMGenerateResult<T>;
};

const readString = (record: Record<string, unknown> | null, key: string): string | null => {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const readNumber = (record: Record<string, unknown> | null, key: string): number | null => {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** 从 data 中提取 stockId：顶层 → holding/position/stock/quote 内嵌。 */
const extractStockId = (data: unknown): string => {
  const record = asRecord(data);
  if (!record) return 'UNKNOWN';
  for (const key of ['stockId', 'subjectId', 'code']) {
    const value = readString(record, key);
    if (value) return value;
  }
  for (const key of ['holding', 'position', 'stock', 'quote']) {
    const value = readString(asRecord(record[key]), 'stockId');
    if (value) return value;
  }
  return 'UNKNOWN';
};

interface PositionContext {
  readonly avgCost: number;
  readonly quantity: number;
}

/** 从 data 中提取持仓上下文（holding / position）。 */
const extractPosition = (data: unknown): PositionContext | null => {
  const record = asRecord(data);
  if (!record) return null;
  for (const key of ['holding', 'position']) {
    const inner = asRecord(record[key]);
    const avgCost = readNumber(inner, 'avgCost');
    const quantity = readNumber(inner, 'quantity');
    if (avgCost !== null && quantity !== null && avgCost > 0 && quantity > 0) {
      return { avgCost, quantity };
    }
  }
  return null;
};

/** 从 data 中提取最新价（quote.close / quotes[stockId].close / price）。 */
const extractClose = (data: unknown, stockId: string): number | null => {
  const record = asRecord(data);
  if (!record) return null;
  const direct = readNumber(asRecord(record.quote), 'close') ?? readNumber(record, 'price');
  if (direct !== null) return direct;
  const quotes = asRecord(record.quotes);
  return readNumber(asRecord(quotes?.[stockId]), 'close');
};

const DECISIONS: readonly AdviceDecision[] = ['buy', 'sell', 'hold', 'watch', 'avoid'];
const HORIZONS: readonly AdviceHorizon[] = ['intraday', 'short', 'medium', 'long'];

const EVIDENCE_POOL = [
  '日线 MA5/MA10/MA20 粘合，方向待选择',
  '近 5 日成交量低于 20 日均量',
  '近 20 日价格波动率处于历史中枢',
  '战法扫描未触发强信号',
] as const;

const COUNTER_POOL = [
  '所属板块近期整体回暖',
  '大盘系统性风险尚未释放',
  '消息面存在不确定性',
] as const;

const RISK_POOL = ['大盘系统性下行风险', '行业政策变化风险', '个股流动性风险'] as const;

/**
 * MockLLMAdapter（MVP-TASK §2.5 mock-llm）。
 * 不调任何外部 API；generate 按 data 中的 stockId + 持仓上下文生成
 * deterministic 分析结果（同一输入同一输出），并按传入 zod schema parse，
 * parse 失败时返回稳定 fallback。
 */
export class MockLLMAdapter implements LLMAdapter {
  readonly name = 'mock-llm';

  private detectMode(system: string): MockMode {
    // chat 最先判定：chat 的 system prompt 会提及其它 tool 名（如引导文案中的
    // analyze_stock），若按内容包含匹配会被误判。
    if (system.includes(MOCK_LLM_SYSTEM_CHAT_PLAN)) return 'chat_plan';
    if (system.includes(MOCK_LLM_SYSTEM_CHAT_REPLY)) return 'chat_reply';
    if (system.includes(MOCK_LLM_SYSTEM_ANALYZE_POSITION)) return 'analyze_position';
    if (system.includes(MOCK_LLM_SYSTEM_ANALYZE_STOCK)) return 'analyze_stock';
    if (system.includes(MOCK_LLM_SYSTEM_MARKET_OUTLOOK)) return 'market_outlook';
    if (system.includes(MOCK_LLM_SYSTEM_SCORE_SIGNALS)) return 'score_signals';
    if (system.includes(MOCK_LLM_SYSTEM_RESOLVE_LLM_GROUP)) return 'resolve_llm_group';
    return 'generic';
  }

  /** 核心生成逻辑：decision/confidence/horizon 由 stockId hash + 持仓上下文决定。 */
  generate<T = unknown>(request: LLMGenerateRequest): Promise<LLMGenerateResult<T>> {
    const mode = this.detectMode(request.system);
    // score_signals 的 schema 是 array，需要直接生成 array（绕过 MockAnalysisOutput 形状）。
    if (mode === 'score_signals') {
      const ranked = this.buildScoreSignalsArray(request.data);
      const raw = JSON.stringify({ mock: true, mode, count: ranked.length });
      const schema = request.schema;
      if (isSchemaLike(schema)) {
        const parsed = schema.safeParse(ranked);
        if (parsed.success) return Promise.resolve(asGenerateResult<T>(parsed.data, raw));
        return Promise.resolve(asGenerateResult<T>(ranked, raw));
      }
      return Promise.resolve(asGenerateResult<T>(ranked, raw));
    }
    // resolve_llm_group：schema 是 { members: [{stockId, rationale}] }，从 candidates 确定性挑选。
    if (mode === 'resolve_llm_group') {
      const out = this.buildResolveLlmGroup(request.data);
      const raw = JSON.stringify({ mock: true, mode, count: out.members.length });
      const schema = request.schema;
      if (isSchemaLike(schema)) {
        const parsed = schema.safeParse(out);
        if (parsed.success) return Promise.resolve(asGenerateResult<T>(parsed.data, raw));
      }
      return Promise.resolve(asGenerateResult<T>(out, raw));
    }
    // chat（web 对话助手，docs/web-chat-design.md §2）：fixture 注入或稳定兜底。
    if (mode === 'chat_plan' || mode === 'chat_reply') {
      const out = this.buildChatOutput(mode, request.data);
      const raw = JSON.stringify({ mock: true, mode });
      const schema = request.schema;
      if (isSchemaLike(schema)) {
        const parsed = schema.safeParse(out);
        if (parsed.success) return Promise.resolve(asGenerateResult<T>(parsed.data, raw));
      }
      return Promise.resolve(asGenerateResult<T>(out, raw));
    }
    return Promise.resolve(this.buildStandardAnalysis(mode, request, request.schema));
  }

  /**
   * chat 模式输出（web-chat-design §6）：
   * - data.message 以 MOCK_CHAT_FIXTURE_PREFIX 开头 → 其余部分 JSON parse 为 plan
   *   （pass2Reply 字段留给 chat_reply 使用；plan.reply 中 ${historyLength} 替换为实际轮数）；
   * - 无 fixture → 稳定兜底 reply（与生产「LLM 解析失败」走同一兜底文案）。
   * fixture parse 失败按无 fixture 处理，保证 mock 永不抛。
   */
  private buildChatOutput(
    mode: 'chat_plan' | 'chat_reply',
    data: unknown,
  ): Record<string, unknown> {
    const record = asRecord(data);
    const message = readString(record, 'message') ?? '';
    const historyLength = Array.isArray(record?.history)
      ? (record.history as readonly unknown[]).length
      : 0;
    const fixture = this.parseChatFixture(message);
    if (mode === 'chat_reply') {
      const pass2 = fixture === null ? null : readString(fixture, 'pass2Reply');
      return { reply: pass2 ?? 'mock 兜底：暂时无法整理查询结果，请换个说法重试。' };
    }
    if (fixture !== null) {
      const reply = readString(fixture, 'reply');
      return {
        ...fixture,
        ...(reply !== null
          ? // biome-ignore lint/suspicious/noTemplateCurlyInString: 字面占位符，mock fixture 的 history 长度探针
            { reply: reply.replaceAll('${historyLength}', String(historyLength)) }
          : {}),
      };
    }
    return {
      reply: 'mock 兜底：暂时无法处理，请换个说法，或使用左侧导航的页面功能。',
      actions: [],
      drafts: [],
    };
  }

  /** 解析 chat fixture；message 不带前缀或 JSON 非法时返回 null。 */
  private parseChatFixture(message: string): Record<string, unknown> | null {
    if (!message.startsWith(MOCK_CHAT_FIXTURE_PREFIX)) return null;
    try {
      return asRecord(JSON.parse(message.slice(MOCK_CHAT_FIXTURE_PREFIX.length)));
    } catch {
      return null;
    }
  }

  /**
   * LLM 分组解析 mock 输出（分组化起）：从 data.candidates 确定性取前
   * min(maxMembers, candidates.length) 条，rationale 固定为 "mock: ..."。
   */
  private buildResolveLlmGroup(data: unknown): {
    members: Array<{ stockId: string; rationale: string }>;
  } {
    const record = asRecord(data);
    const candidates = Array.isArray(record?.candidates)
      ? (record.candidates as readonly unknown[])
      : [];
    const maxMembers = readNumber(record, 'maxMembers') ?? 20;
    const prompt = readString(record, 'prompt') ?? '';
    const members = candidates
      .map((c) => readString(asRecord(c), 'stockId'))
      .filter((id): id is string => id !== null)
      .slice(0, Math.max(1, Math.min(maxMembers, 100)))
      .map((stockId) => ({
        stockId,
        rationale: `mock: 按「${prompt.slice(0, 30)}」选中`,
      }));
    return { members };
  }

  private buildStandardAnalysis<T>(
    mode: MockMode,
    request: LLMGenerateRequest,
    schema: unknown,
  ): LLMGenerateResult<T> {
    const stockId = extractStockId(request.data);
    const candidate = this.buildAnalysis(mode, stockId, request.data);
    const raw = JSON.stringify({
      mock: true,
      adapter: this.name,
      mode,
      stockId,
      seed: hashString(`${mode}|${stockId}`),
      note: 'deterministic mock reasoning',
    });
    if (isSchemaLike(schema)) {
      const parsed = schema.safeParse(candidate);
      if (parsed.success) return asGenerateResult<T>(parsed.data, raw);
      const fallback = this.fallbackAnalysis(stockId);
      const reparsed = schema.safeParse(fallback);
      return asGenerateResult<T>(reparsed.success ? reparsed.data : fallback, raw);
    }
    return asGenerateResult<T>(candidate, raw);
  }

  private buildAnalysis(mode: MockMode, stockId: string, data: unknown): MockAnalysisOutput {
    if (mode === 'market_outlook') return this.buildMarketOutlook(data);

    const seed = hashString(`${mode}|${stockId}`);
    const rand = mulberry32(seed);

    let decision = pickDeterministic(DECISIONS, seed);
    let confidence = 40 + (seed % 55); // 40-94
    const horizon = pickDeterministic(HORIZONS, hashString(`horizon|${mode}|${stockId}`));

    let premise = `mock 分析（${mode}）：${stockId} 综合信号指向「${decision}」。`;

    // 持仓上下文调整：浮盈 ≥15% 止盈优先；浮亏 ≥10% 转持有观望。
    const position = extractPosition(data);
    const close = extractClose(data, stockId);
    if (position && close !== null) {
      const pnlRate = (close - position.avgCost) / position.avgCost;
      const pnlPct = (pnlRate * 100).toFixed(1);
      if (pnlRate >= 0.15) {
        decision = 'sell';
        confidence = Math.max(confidence, 70);
        premise = `mock 分析（${mode}）：${stockId} 持仓浮盈 ${pnlPct}%，建议分批止盈。`;
      } else if (pnlRate <= -0.1) {
        decision = 'hold';
        premise = `mock 分析（${mode}）：${stockId} 持仓浮亏 ${pnlPct}%，建议持有等待修复。`;
      }
    }

    const reasoning: AdviceReasoning = {
      premise,
      evidence: [
        pickDeterministic(EVIDENCE_POOL, Math.floor(rand() * 1000)),
        pickDeterministic(EVIDENCE_POOL, Math.floor(rand() * 1000) + 1),
      ],
      counterEvidence: [pickDeterministic(COUNTER_POOL, Math.floor(rand() * 1000))],
    };

    const risks = [
      pickDeterministic(RISK_POOL, Math.floor(rand() * 1000)),
      pickDeterministic(RISK_POOL, Math.floor(rand() * 1000) + 2),
    ];

    return { decision, confidence, horizon, reasoning, risks };
  }

  /**
   * 市场 / 板块观点 mock 输出：
   * - avgChangePct ≥ +1% → bullish（buy / avoid 都不会是真实选择）
   * - avgChangePct ≤ -1% → bearish
   * - 其它 → neutral (hold)
   */
  private buildMarketOutlook(data: unknown): MockAnalysisOutput {
    const record = asRecord(data);
    const avgChangePct = readNumber(record, 'avgChangePct') ?? 0;
    const evaluatedStocks = readNumber(record, 'evaluatedStocks') ?? 0;
    const decision: AdviceDecision =
      avgChangePct >= 0.01 ? 'buy' : avgChangePct <= -0.01 ? 'sell' : 'hold';
    const confidence = Math.min(85, 50 + Math.floor(Math.abs(avgChangePct) * 1000));
    return {
      decision,
      confidence,
      horizon: 'short',
      reasoning: {
        premise: `mock 市场观点：评估 ${evaluatedStocks} 只股票，平均涨跌 ${(avgChangePct * 100).toFixed(2)}%`,
        evidence: [
          `市场宽度：${avgChangePct >= 0 ? '上涨家数居多' : '下跌家数居多'}`,
          `平均涨跌幅 ${(avgChangePct * 100).toFixed(2)}%`,
        ],
        counterEvidence: ['样本可能含板块偏好，结论非全市场'],
      },
      risks: ['系统性风险', '板块集中度风险'],
    };
  }

  /**
   * 战法信号精排 mock 输出（v0.3）：对每个 signal 的原 score 做 ±20 微调，
   * rationale 固定为 "mock: ..."。schema 是 Array<{tacticId, stockId, ts, llmScore, rationale}>。
   */
  private buildScoreSignalsArray(
    data: unknown,
  ): Array<{ tacticId: string; stockId: string; ts: string; llmScore: number; rationale: string }> {
    const record = asRecord(data);
    const signals = Array.isArray(record?.signals) ? (record.signals as readonly unknown[]) : [];
    return signals.map((s) => {
      const r = asRecord(s);
      const origScore = readNumber(r, 'score') ?? 50;
      const seed = hashString(
        `${readString(r, 'tacticId') ?? 'x'}|${readString(r, 'stockId') ?? 'y'}|${readString(r, 'ts') ?? 'z'}`,
      );
      const offset = (seed % 41) - 20; // ±20
      const llmScore = Math.max(0, Math.min(100, origScore + offset));
      return {
        tacticId: readString(r, 'tacticId') ?? '',
        stockId: readString(r, 'stockId') ?? '',
        ts: readString(r, 'ts') ?? '',
        llmScore,
        rationale: `mock: 基于原 score=${origScore} 微调 ${offset >= 0 ? '+' : ''}${offset}`,
      };
    });
  }

  /** 稳定 fallback：与输入无关（除 stockId），保证 schema 失败时输出仍可预测。 */
  private fallbackAnalysis(stockId: string): MockAnalysisOutput {
    return {
      decision: 'watch',
      confidence: 50,
      horizon: 'short',
      reasoning: {
        premise: `mock 兜底：暂时无法形成对 ${stockId} 的有效判断，建议观望。`,
        evidence: ['mock 兜底：结构化输出校验未通过，降级为观望'],
        counterEvidence: ['mock 兜底：观望本身也可能错失波动机会'],
      },
      risks: ['mock 兜底：本结果为降级输出，参考价值有限'],
    };
  }
}
