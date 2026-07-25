import type { LimitUpLadderAdapterLike, LimitUpLadderRawEntry } from './types.js';

/**
 * Amazingdata 数据源 adapter（Phase 1 占位）。
 *
 * 职责：amazingdata SDK 尚未接入，仅保留接口 + throw，帮助区分「未配置」与「真实失败」。
 * Phase 2 实现时补完真实 fetch 逻辑。
 */
export class AmazingdataLimitUpLadderAdapter implements LimitUpLadderAdapterLike {
  readonly name = 'amazingdata' as const;

  async fetchLadder(
    _date: string,
    _opts?: { readonly days?: number },
  ): Promise<{ readonly date: string; readonly entries: LimitUpLadderRawEntry[] }> {
    throw new Error(
      'Amazingdata limit-up ladder adapter not implemented yet. ' +
        'Set LUOOME_LIMIT_UP_LADDER_FALLBACK=amazingdata only after Phase 2 is ready.',
    );
  }
}
