import {
  assertStrategyInvariants,
  assertStrategyVersionInvariants,
  type Strategy,
  type StrategyDslV1,
  StrategyDslV1Schema,
  type StrategyRule,
  type StrategySignalRule,
  type StrategyVersion,
  strategyDefinitionHash,
} from '../entity/strategy.js';
import { inspectStrategyDefinitionReferences } from './field-registry.js';

/**
 * 内置 Strategy 静态种子（替代 v0.3 内置战法 + legacy-mapper 的运行时转换）。
 *
 * 身份约束：
 * - strategy.id 稳定；每次内置定义升级必须发布固定的新 revision，不能原地改写旧版本。
 * - signal rule id（`legacy-signal`）沿用旧映射身份；definitionHash 锁定该 revision 的定义。
 * - 调用方（ensureBuiltinStrategies）负责把存量 builtin 协调到本 revision，不覆盖用户同名 Strategy。
 *
 * 2026-07-31：为每个种子补 selection rule（`legacy-selection`，与 signal 同条件），
 * 让「从模板导入」创建的用户策略满足普通用户至少一条 selection rule 的不变量；
 * 同时让内置策略运行结果的 selected 从恒 true 变为按条件过滤（signals 求值不受影响）。
 * definitionHash 随之变化，builtin.test.ts 的 EXPECTED 表已同步。
 *
 * 2026-08-02：为每个种子补 scoring（weighted-sum，单组件引用 `legacy-selection`，
 * score 沿用 seed.score，weight=1；不设 top 避免截断 selected）。此前种子 DSL 无
 * scoring 块，股票池 rank/score 恒为 '--'；补上后运行结果才有 score 与稳定排名。
 * definitionHash 再次变化，builtin.test.ts 的 EXPECTED 表已同步。
 */
export interface BuiltinStrategyBundle {
  readonly strategy: Strategy;
  readonly version: StrategyVersion;
}

/** builtin 种子时间（固化，避免每次 new Date 漂移；与历史播种值一致）。 */
export const STRATEGY_BUILTIN_DEFINED_AT = new Date('2026-07-01T00:00:00.000Z');
export const STRATEGY_BUILTIN_REVISION = 3;

interface BuiltinStrategySeed {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** DSL metadata.style（沿用 legacy tactic tag 取值）。 */
  readonly style: 'momentum' | 'mean-reversion' | 'volume' | 'risk' | 'pattern';
  /** signal 归属桶（legacy 映射：tag=risk → risk；direction=bearish → exit；其余 entry）。 */
  readonly bucket: 'entry' | 'exit' | 'risk';
  readonly direction: 'bullish' | 'bearish' | 'neutral';
  readonly when: string;
  readonly score: string;
  readonly evidence: readonly string[];
}

const BUILTIN_STRATEGY_SEEDS: readonly BuiltinStrategySeed[] = [
  {
    id: 'breakout-volume',
    name: '放量突破',
    description: '5 日均量 > 20 日均量 × 1.5 且收盘 ≥ 近 20 日最高，典型动量启动信号',
    style: 'momentum',
    bucket: 'entry',
    direction: 'bullish',
    when:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '${indicators.volRatio5_20} !== undefined && ${indicators.volRatio5_20} >= 1.5 && ${indicators.close} >= ${indicators.high20}',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
    score: 'Math.min(100, ${indicators.volRatio5_20} * 30)',
    evidence: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '量比 volRatio5_20=${indicators.volRatio5_20}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '收盘 ${indicators.close} ≥ 20 日最高 ${indicators.high20}',
    ],
  },
  {
    id: 'ma-bullish-alignment',
    name: '均线多头',
    description: 'MA5 > MA10 > MA20 多头排列，趋势确认',
    style: 'momentum',
    bucket: 'entry',
    direction: 'bullish',
    when:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '${indicators.ma5} !== undefined && ${indicators.ma5} > ${indicators.ma10} && ${indicators.ma10} > ${indicators.ma20}',
    score:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      'Math.min(100, ((${indicators.ma5} - ${indicators.ma20}) / ${indicators.ma20}) * 1000 + 50)',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
    evidence: ['MA5=${indicators.ma5} > MA10=${indicators.ma10} > MA20=${indicators.ma20}'],
  },
  {
    id: 'pullback-after-limit-up',
    name: '涨停回踩',
    description: '近 5 日内曾涨停（涨幅 ≥ 9.5%），现价回踩 5 日均线不破',
    style: 'mean-reversion',
    bucket: 'entry',
    direction: 'bullish',
    when:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '${meta.recentLimitUp} === true && ${indicators.close} >= ${indicators.ma5} * 0.98',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
    score: '60 + Math.min(40, ${meta.daysSinceLimitUp} * 5)',
    evidence: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '近 ${meta.daysSinceLimitUp} 日内涨停',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '现价 ${indicators.close} 在 MA5（${indicators.ma5}）附近',
    ],
  },
  {
    id: 'volume-price-divergence',
    name: '量价背离',
    description: '价格上涨但成交量萎缩（5 日均量 < 20 日均量 × 0.7），警惕反转',
    style: 'volume',
    bucket: 'exit',
    direction: 'bearish',
    when:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '${meta.priceUp} === true && ${indicators.volRatio5_20} !== undefined && ${indicators.volRatio5_20} <= 0.7',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
    score: 'Math.min(100, (1 - ${indicators.volRatio5_20}) * 50)',
    evidence: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '近期价格上涨但量比 volRatio5_20=${indicators.volRatio5_20} ≤ 0.7',
      '典型量价背离，注意反转',
    ],
  },
  {
    id: 'sector-resonance',
    name: '板块共振',
    description: '个股所在板块 3 日平均涨幅 ≥ 2%，个股跟随上涨 ≥ 1.5%',
    style: 'pattern',
    bucket: 'entry',
    direction: 'bullish',
    when:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '${meta.sectorAvgChange3d} !== undefined && ${meta.sectorAvgChange3d} >= 0.02 && ${meta.stockChange3d} !== undefined && ${meta.stockChange3d} >= 0.015',
    score:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      'Math.min(100, ${meta.sectorAvgChange3d} * 1000 + ${meta.stockChange3d} * 1500)',
    evidence: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '板块 3 日均涨 ${meta.sectorAvgChange3d}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '个股 3 日涨幅 ${meta.stockChange3d}',
    ],
  },
  {
    id: 'early-breakout',
    name: '早期突破',
    description: '价格刚站上 MA20/MA60，20 日动量 2%～15%、RSI14 处于 45～70，且量能温和放大',
    style: 'momentum',
    bucket: 'entry',
    direction: 'bullish',
    when:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '${indicators.close} > ${indicators.ma20} && ${indicators.ma5} > ${indicators.ma20} && ${indicators.momentum20Pct} >= 2 && ${indicators.momentum20Pct} <= 15 && ${indicators.volRatio5_20} >= 1.2 && ${indicators.rsi14} >= 45 && ${indicators.rsi14} <= 70 && ${indicators.maDistance20Pct} <= 12 && (${indicators.daysSinceMa20CrossUp} <= 2 || ${indicators.daysSinceMa60CrossUp} <= 2 || ${indicators.daysAboveMa20} <= 3)',
    score:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      'Math.min(100, 40 + Math.min(20, (${indicators.volRatio5_20} - 1.2) * 10) + Math.max(0, 20 - Math.abs(${indicators.momentum20Pct} - 8) * 2) + Math.max(0, 20 - Math.abs(${indicators.rsi14} - 60) * 0.8))',
    evidence: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '20日动量=${indicators.momentum20Pct}%，RSI14=${indicators.rsi14}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '量比=${indicators.volRatio5_20}，MA20距离=${indicators.maDistance20Pct}%',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      'MA20上穿距今=${indicators.daysSinceMa20CrossUp}日，连续站上MA20=${indicators.daysAboveMa20}日',
    ],
  },
  {
    id: 'bollinger-band',
    name: '布林带均值回复',
    description: '价格跌至 Bollinger 20 日下轨、RSI14 低于 45，但仍位于 MA60 上方的超跌研究信号',
    style: 'mean-reversion',
    bucket: 'entry',
    direction: 'bullish',
    when:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '${indicators.close} < ${indicators.ma20} && ${indicators.close} > ${indicators.ma60} && ${indicators.rsi14} < 45 && ${indicators.momentum20Pct} > -15 && ${indicators.volRatio5_20} >= 1 && ${indicators.bollPosition20} <= 0',
    score:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      'Math.min(100, Math.abs(${indicators.maDistance20Pct}) * 3 + ${indicators.volRatio5_20} * 15 + (45 - ${indicators.rsi14}))',
    evidence: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '收盘=${indicators.close} ≤ Bollinger下轨=${indicators.bollLower20}，位置=${indicators.bollPosition20}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      'RSI14=${indicators.rsi14}，MA20距离=${indicators.maDistance20Pct}%',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder
      '长期趋势未破：收盘=${indicators.close} > MA60=${indicators.ma60}',
    ],
  },
];

const buildBuiltinBundle = (seed: BuiltinStrategySeed): BuiltinStrategyBundle => {
  const signalRule: StrategySignalRule = {
    // rule id 参与 definitionHash，沿用历史播种值
    id: 'legacy-signal',
    name: seed.name,
    when: seed.when,
    score: seed.score,
    direction: seed.direction,
    evidence: [...seed.evidence],
  };
  // selection 与 signal 同条件：模板导入的用户策略必须至少一条 selection rule
  const selectionRule: StrategyRule = {
    id: 'legacy-selection',
    name: seed.name,
    when: seed.when,
    evidence: [...seed.evidence],
  };
  const definition: StrategyDslV1 = StrategyDslV1Schema.parse({
    schemaVersion: 1,
    metadata: { style: seed.style },
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: { logic: 'all', rules: [selectionRule] },
    // 单组件加权：让运行结果带 score 与稳定排名；不设 top 避免截断 selected
    scoring: {
      method: 'weighted-sum',
      components: [{ ruleId: 'legacy-selection', score: seed.score, weight: 1 }],
    },
    signals: {
      entry: seed.bucket === 'entry' ? [signalRule] : [],
      exit: seed.bucket === 'exit' ? [signalRule] : [],
      risk: seed.bucket === 'risk' ? [signalRule] : [],
    },
  });
  // 内置种子同样过字段注册静态校验；不 valid 不签 publishedAt（不变量硬约束）
  const validationErrors = [...inspectStrategyDefinitionReferences(definition).validationErrors];
  const valid = validationErrors.length === 0;
  const version: StrategyVersion = {
    id: `${seed.id}-v${STRATEGY_BUILTIN_REVISION}`,
    strategyId: seed.id,
    version: STRATEGY_BUILTIN_REVISION,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    changeSummary: '内置策略 revision 3：selection、scoring 与派生 meta 上下文',
    validationStatus: valid ? 'valid' : 'invalid',
    validationErrors,
    ...(valid ? { publishedAt: STRATEGY_BUILTIN_DEFINED_AT } : {}),
    createdAt: STRATEGY_BUILTIN_DEFINED_AT,
  };
  const strategy: Strategy = {
    id: seed.id,
    name: seed.name,
    description: seed.description,
    owner: 'builtin',
    status: 'active',
    currentVersionId: version.id,
    createdAt: STRATEGY_BUILTIN_DEFINED_AT,
    updatedAt: STRATEGY_BUILTIN_DEFINED_AT,
  };
  assertStrategyInvariants(strategy);
  assertStrategyVersionInvariants(version, 'builtin');
  return { strategy, version };
};

export const BUILTIN_STRATEGIES: readonly BuiltinStrategyBundle[] =
  BUILTIN_STRATEGY_SEEDS.map(buildBuiltinBundle);
