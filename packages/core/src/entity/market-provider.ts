import { z } from 'zod';

/**
 * 行情适配器配置（v0.5 起独立模块，镜像 llm-provider.ts 的 env 路由先例）。
 *
 * 设计要点：
 * - 2 个 provider：mock（默认，全链路 deterministic）/ real（Eastmoney 主 →
 *   Tencent 备 → Mock 兜底的 MarketDataManager 链，A 股）。
 * - 缺省 / 空串 / 'mock' → mock：四个 surface（CLI/TUI/Web/MCP）不加 env 时
 *   行为与 v0.4 完全一致，测试与 demo 的确定性不受影响。
 * - 非法值启动期抛错（对齐 parseLlmProviderConfigFromEnv），不在 tool 调用期炸。
 * - core 只做配置解析；适配器装配（factory）在 adapters 包，依赖方向不倒。
 */
export type MarketProviderName = 'mock' | 'real';

export const MarketProviderNameSchema = z.enum(['mock', 'real']);

/** 顺序固定，日志 / 报错文案遍历时稳定。 */
export const ALL_MARKET_PROVIDERS: readonly MarketProviderName[] = ['mock', 'real'] as const;

export interface MarketProviderConfig {
  readonly provider: MarketProviderName;
}

export const MarketProviderConfigSchema = z.object({
  provider: MarketProviderNameSchema,
});

/**
 * 从 env 解析 MarketProviderConfig（adapter 装配入口）。
 *
 * 行为约定：
 * - LUOOME_MARKET_PROVIDER 缺省 / 空串 / 纯空白 / 'mock' → provider='mock'。
 * - 'real' → provider='real'（大小写不敏感，先 trim 再小写）。
 * - 其它值 → 抛错（启动期暴露配置拼写错误）。
 */
export const parseMarketProviderConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): MarketProviderConfig => {
  const rawProvider = env.LUOOME_MARKET_PROVIDER?.trim().toLowerCase() ?? 'mock';
  if (rawProvider === '' || rawProvider === 'mock') {
    return { provider: 'mock' };
  }
  const providerParse = MarketProviderNameSchema.safeParse(rawProvider);
  if (!providerParse.success) {
    throw new Error(
      `LUOOME_MARKET_PROVIDER="${rawProvider}" 非法，必须是 ${ALL_MARKET_PROVIDERS.join(' | ')}`,
    );
  }
  return { provider: providerParse.data };
};
