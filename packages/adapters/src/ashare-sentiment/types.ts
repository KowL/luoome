export const A_SHARE_SENTIMENT_COVERAGE = 'CN_A_SHARES_SH_SZ' as const;
export type AShareSentimentCoverage = typeof A_SHARE_SENTIMENT_COVERAGE;

export interface AShareSentimentRawEntry {
  readonly stockId: string;
  readonly name: string;
  readonly ladderLevel: number;
  readonly sealAmount: number | null;
  readonly openCount: number | null;
  readonly industry?: string;
  readonly concepts: readonly string[];
}

export type AShareSentimentRawPool =
  | {
      readonly ok: true;
      readonly observedAt: Date;
      readonly fetchedAt: Date;
      readonly entries: readonly AShareSentimentRawEntry[];
    }
  | {
      readonly ok: false;
      readonly fetchedAt: Date;
      readonly errorKind: 'network_error' | 'http_error' | 'invalid_response' | 'unsupported_date';
      readonly errorMessage: string;
    };

/**
 * 池级情绪源（docs/ddd/source-pluggability-and-observation-design.md §4.2/§4.3）。
 *
 * 封板 / 炸板是两个独立 capability：manager 分别路由、分别 fallback 后再组装快照，
 * 单池失败不被整体成功掩盖。池级失败以 ok:false 池返回（存量结果契约），不抛错。
 */
export interface AShareSentimentPoolSource {
  readonly name: string;
  fetchSealedPool(input: {
    readonly date: string;
    readonly coverage: AShareSentimentCoverage;
  }): Promise<AShareSentimentRawPool>;
  fetchBrokenPool(input: {
    readonly date: string;
    readonly coverage: AShareSentimentCoverage;
  }): Promise<AShareSentimentRawPool>;
}

/** 情绪域的 capability map（SourceRegistry 实例化，§6.2）。 */
export type AShareSentimentCapabilityMap = {
  readonly 'sentiment-sealed-pool': {
    readonly request: { readonly date: string; readonly coverage: AShareSentimentCoverage };
    readonly result: AShareSentimentRawPool;
  };
  readonly 'sentiment-broken-pool': {
    readonly request: { readonly date: string; readonly coverage: AShareSentimentCoverage };
    readonly result: AShareSentimentRawPool;
  };
};
