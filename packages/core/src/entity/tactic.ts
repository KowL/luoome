import { z } from 'zod';

/**
 * 战法（v0.3 起第一类实体，ARCHITECTURE §5.1）。
 *
 * 战法 DSL 用 YAML 定义（详见 plan-v0.2-v0.3 §2.4）：
 *   id / name / tag / description / trigger.when / signal.score / signal.direction / signal.evidence
 *
 * `trigger.when` 是 mini-eval 表达式（自实现，不引第三方表达式库）：
 *   - 操作数：context（run_tactic 注入的 indicators / quote / meta）
 *   - 运算符：&& / || / ! / 比较 / 算术
 *   - 函数：Math.min / Math.max / Math.abs
 *
 * `signal.score` 是「满足 trigger 后怎么打分」的模板（同样的 mini-eval）。
 *
 * 不变量：
 * - id 唯一，slug 形式（kebab-case）
 * - tag ∈ TacticTag 枚举
 * - direction ∈ TacticDirection 枚举
 */

export type TacticTag = 'momentum' | 'mean-reversion' | 'volume' | 'risk' | 'pattern';
export type TacticDirection = 'bullish' | 'bearish' | 'neutral';
export type TacticSource = 'builtin' | 'user';

export const TacticTagSchema = z.enum(['momentum', 'mean-reversion', 'volume', 'risk', 'pattern']);

export const TacticDirectionSchema = z.enum(['bullish', 'bearish', 'neutral']);
// 别名：避免与 advice.ts 中遗留的 TacticSignalDirectionSchema 冲突期重名
export const TacticSignalDirectionSchema = TacticDirectionSchema;
export const TacticSourceSchema = z.enum(['builtin', 'user']);

export const TacticSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, {
    message: 'tactic.id 必须小写 kebab-case，长度 2-64',
  }),
  name: z.string().min(1).max(64),
  tag: TacticTagSchema,
  description: z.string().min(1).max(500),
  /** 触发条件表达式（命中后输出 signal）。 */
  triggerWhen: z.string().min(1).max(500),
  /** 打分模板表达式（命中 trigger 后算 score，0-100）。 */
  scoreExpression: z.string().min(1).max(500),
  direction: TacticDirectionSchema,
  /** 证据模板，每条一行字符串。运行时会用 context 替换 ${...} 占位符。 */
  evidenceTemplate: z.array(z.string().min(1)).min(1).max(8),
  source: TacticSourceSchema,
  /** ISO 时间戳；builtin 战法用固化时间，user 战法为 save 时间。 */
  definedAt: z.coerce.date(),
});

export type Tactic = z.infer<typeof TacticSchema>;

/** 信号：战法运行的输出（ARCHITECTURE §5.1）。 */
export interface TacticSignal {
  readonly tacticId: string;
  readonly tacticName: string;
  readonly tacticTag: TacticTag;
  readonly stockId: string;
  readonly ts: Date;
  readonly score: number; // 0-100
  readonly direction: TacticDirection;
  readonly evidence: readonly string[];
  /** 触发的 raw 表达式 + 求值上下文（用于审计 + DSL 调试）。 */
  readonly triggerSnapshot?: { readonly expression: string; readonly result: boolean };
}

export const TacticSignalSchema = z.object({
  tacticId: z.string().min(1),
  tacticName: z.string().min(1),
  tacticTag: TacticTagSchema,
  stockId: z.string().min(1),
  ts: z.coerce.date(),
  score: z.number().min(0).max(100),
  direction: TacticDirectionSchema,
  evidence: z.array(z.string()),
  triggerSnapshot: z
    .object({
      expression: z.string(),
      result: z.boolean(),
    })
    .optional(),
});

/**
 * 战法运行参数（run_tactic 工具的输入）。
 * scope: 'watchlist'（用户自选股）/ 'all-fixtures'（全部 stock）/ 'tactic:<id>' 跑单战术
 *        / 'holdings'（账户下所有活跃持仓）。
 */
export const RunTacticInput = z.object({
  tacticId: z.string().min(1),
  scope: z.enum(['holdings', 'watchlist', 'all-stocks']).default('holdings'),
  /** scope=watchlist 时必填。 */
  stockIds: z.array(z.string()).optional(),
  /** 拉日线的回看窗口（默认 120 天）。 */
  lookbackDays: z.number().int().positive().max(365).default(120),
});

export type RunTacticInputT = z.infer<typeof RunTacticInput>;

// ---------- 不变量 ----------

/**
 * 战法不变量：DSL 表达式必须非空且长度合理；direction 必须与 tag 兼容。
 * 兼容性规则（v0.3 简版）：
 *   - risk → bearish 或 neutral（不允许 bullish，避免「风险战法推涨」的歧义）
 *   - 其它 tag 任意 direction
 */
export const assertTacticInvariants = (tactic: Tactic): void => {
  if (tactic.id.length < 2 || tactic.id.length > 64) {
    throw new Error(`tactic.id 长度 2-64，实际 ${tactic.id.length}`);
  }
  if (tactic.tag === 'risk' && tactic.direction === 'bullish') {
    throw new Error(`tag='risk' 的战法 direction 不能是 bullish（避免「风险战法推涨」歧义）`);
  }
  // trigger / score 表达式粗粒度校验：禁止注释、import、函数声明（避免恶意 DSL）
  const forbidden = ['import', 'require', 'function ', '=>', 'eval(', 'Function('];
  for (const kw of forbidden) {
    if (tactic.triggerWhen.includes(kw) || tactic.scoreExpression.includes(kw)) {
      throw new Error(`战法表达式禁用关键字: "${kw}"`);
    }
  }
};

export const assertTacticSignalInvariants = (signal: TacticSignal): void => {
  if (signal.score < 0 || signal.score > 100) {
    throw new Error(`tactic signal score 越界 [0,100]: ${signal.score}`);
  }
  if (signal.evidence.length === 0) {
    throw new Error('tactic signal 至少 1 条 evidence');
  }
};

// ---------- 内置战法（v0.3 全部 5 个；fixtures 与 DSL 引擎同时使用） ----------

/** builtin 战法定义时间（固化，避免每次 new Date 漂移）。 */
export const TACTIC_BUILTIN_DEFINED_AT = new Date('2026-07-01T00:00:00.000Z');

/** 5 个内置战法（fixture，详见 plan-v0.2-v0.3 §3.4 / DSL 示例 §2.4）。 */
export const BUILTIN_TACTICS: readonly Tactic[] = [
  {
    id: 'breakout-volume',
    name: '放量突破',
    tag: 'momentum',
    description: '5 日均量 > 20 日均量 × 1.5 且收盘 ≥ 近 20 日最高，典型动量启动信号',
    triggerWhen:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '${indicators.volRatio5_20} !== undefined && ${indicators.volRatio5_20} >= 1.5 && ${indicators.close} >= ${indicators.high20}',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
    scoreExpression: 'Math.min(100, ${indicators.volRatio5_20} * 30)',
    direction: 'bullish',
    evidenceTemplate: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '量比 volRatio5_20=${indicators.volRatio5_20}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '收盘 ${indicators.close} ≥ 20 日最高 ${indicators.high20}',
    ],
    source: 'builtin',
    definedAt: TACTIC_BUILTIN_DEFINED_AT,
  },
  {
    id: 'ma-bullish-alignment',
    name: '均线多头',
    tag: 'momentum',
    description: 'MA5 > MA10 > MA20 多头排列，趋势确认',
    triggerWhen:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '${indicators.ma5} !== undefined && ${indicators.ma5} > ${indicators.ma10} && ${indicators.ma10} > ${indicators.ma20}',
    scoreExpression:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      'Math.min(100, ((${indicators.ma5} - ${indicators.ma20}) / ${indicators.ma20}) * 1000 + 50)',
    direction: 'bullish',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
    evidenceTemplate: ['MA5=${indicators.ma5} > MA10=${indicators.ma10} > MA20=${indicators.ma20}'],
    source: 'builtin',
    definedAt: TACTIC_BUILTIN_DEFINED_AT,
  },
  {
    id: 'pullback-after-limit-up',
    name: '涨停回踩',
    tag: 'mean-reversion',
    description: '近 5 日内曾涨停（涨幅 ≥ 9.5%），现价回踩 5 日均线不破',
    triggerWhen:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '${meta.recentLimitUp} === true && ${indicators.close} >= ${indicators.ma5} * 0.98',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
    scoreExpression: '60 + Math.min(40, ${meta.daysSinceLimitUp} * 5)',
    direction: 'bullish',
    evidenceTemplate: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '近 ${meta.daysSinceLimitUp} 日内涨停',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '现价 ${indicators.close} 在 MA5（${indicators.ma5}）附近',
    ],
    source: 'builtin',
    definedAt: TACTIC_BUILTIN_DEFINED_AT,
  },
  {
    id: 'volume-price-divergence',
    name: '量价背离',
    tag: 'volume',
    description: '价格上涨但成交量萎缩（5 日均量 < 20 日均量 × 0.7），警惕反转',
    triggerWhen:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '${meta.priceUp} === true && ${indicators.volRatio5_20} !== undefined && ${indicators.volRatio5_20} <= 0.7',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
    scoreExpression: 'Math.min(100, (1 - ${indicators.volRatio5_20}) * 50)',
    direction: 'bearish',
    evidenceTemplate: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '近期价格上涨但量比 volRatio5_20=${indicators.volRatio5_20} ≤ 0.7',
      '典型量价背离，注意反转',
    ],
    source: 'builtin',
    definedAt: TACTIC_BUILTIN_DEFINED_AT,
  },
  {
    id: 'sector-resonance',
    name: '板块共振',
    tag: 'pattern',
    description: '个股所在板块 3 日平均涨幅 ≥ 2%，个股跟随上涨 ≥ 1.5%',
    triggerWhen:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '${meta.sectorAvgChange3d} !== undefined && ${meta.sectorAvgChange3d} >= 0.02 && ${meta.stockChange3d} !== undefined && ${meta.stockChange3d} >= 0.015',
    scoreExpression:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      'Math.min(100, ${meta.sectorAvgChange3d} * 1000 + ${meta.stockChange3d} * 1500)',
    direction: 'bullish',
    evidenceTemplate: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '板块 3 日均涨 ${meta.sectorAvgChange3d}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '个股 3 日涨幅 ${meta.stockChange3d}',
    ],
    source: 'builtin',
    definedAt: TACTIC_BUILTIN_DEFINED_AT,
  },
];
