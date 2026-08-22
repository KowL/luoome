import type { FinancialFact, FundamentalDataAdapterLike } from '@luoome/core';
import { z } from 'zod';

import { MockFundamentalDataAdapter } from './mock.js';

/** 仅用于显式测试/evaluation 注入；没有真实 PIT provider 的默认装配。 */
export const FundamentalProviderIdSchema = z.literal('mock');
export type FundamentalProviderId = z.infer<typeof FundamentalProviderIdSchema>;

export interface CreateFundamentalDataAdapterDeps {
  /** 仅供显式 contract/evaluation fixture 注入；生产 mock 默认使用固定 fixture。 */
  readonly facts?: readonly FinancialFact[];
}

/**
 * 解析基本面 provider。默认不注入；当前唯一允许的 provider 是显式 mock。
 * 该 factory 不读取 process.env，调用方必须传入 env，避免 adapter 隐式取密钥。
 */
export const createFundamentalDataAdapterFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateFundamentalDataAdapterDeps = {},
): FundamentalDataAdapterLike | undefined => {
  const raw = env.LUOOME_FUNDAMENTAL_PROVIDER?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return undefined;

  const provider = FundamentalProviderIdSchema.safeParse(raw);
  if (!provider.success) {
    throw new Error(`不支持的基本面 provider：${raw}；当前仅允许 LUOOME_FUNDAMENTAL_PROVIDER=mock`);
  }

  switch (provider.data) {
    case 'mock':
      return new MockFundamentalDataAdapter(deps.facts === undefined ? {} : { facts: deps.facts });
    default:
      throw new Error('基本面 provider contract 不可达');
  }
};
