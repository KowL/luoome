import type { AdshareClient } from '@luoome/adshare-sdk';
import { fetchLimitUpLadder } from '@luoome/adshare-sdk';

import type { LimitUpLadderAdapterLike, LimitUpLadderRawEntry } from './types.js';

/**
 * Adshare 数据源 adapter（Phase 1 主源）。
 *
 * 职责（docs/ddd/limit-up-ladder-detailed-design.md §4.2）：
 * - 薄封装：把 adshare-sdk fetchLimitUpLadder 结果透传给 manager。
 * - 不做修正（manager 负责 §6.4 收盘价修正）、不做过滤（manager 负责 includeStar/Bse/ST）。
 * - 错误直接向上抛（manager 捕获决定是否 fallback）。
 */
export class AdshareLimitUpLadderAdapter implements LimitUpLadderAdapterLike {
  readonly name = 'adshare' as const;

  constructor(
    private readonly client: AdshareClient,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async fetchLadder(
    date: string,
    opts?: { readonly days?: number },
  ): Promise<{ readonly date: string; readonly entries: LimitUpLadderRawEntry[] }> {
    const query: { readonly date: string; readonly days?: number } =
      opts?.days !== undefined ? { date, days: opts.days } : { date };
    return fetchLimitUpLadder(this.client.url, this.client.apiKey, this.fetchImpl ?? fetch, query, {
      timeoutMs: 10_000,
      retries: 2,
    });
  }
}
