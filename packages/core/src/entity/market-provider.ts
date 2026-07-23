import { z } from 'zod';

/**
 * Production market data configuration.
 *
 * Synthetic providers were removed: every runtime surface must opt into the
 * real Eastmoney → Tencent chain explicitly.
 */
export type MarketProviderName = 'real';

export const MarketProviderNameSchema = z.literal('real');
export const ALL_MARKET_PROVIDERS: readonly MarketProviderName[] = ['real'] as const;

export interface MarketProviderConfig {
  readonly provider: MarketProviderName;
}

export const MarketProviderConfigSchema = z.object({
  provider: MarketProviderNameSchema,
});

export const parseMarketProviderConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): MarketProviderConfig => {
  const rawProvider = env.LUOOME_MARKET_PROVIDER?.trim().toLowerCase();
  if (rawProvider === undefined || rawProvider === '') {
    throw new Error('缺少 LUOOME_MARKET_PROVIDER；生产运行必须显式配置为 real');
  }
  const providerParse = MarketProviderNameSchema.safeParse(rawProvider);
  if (!providerParse.success) {
    throw new Error(
      `LUOOME_MARKET_PROVIDER="${rawProvider}" 非法，必须是 ${ALL_MARKET_PROVIDERS.join(' | ')}`,
    );
  }
  return { provider: providerParse.data };
};
