export const A_SHARE_SENTIMENT_COVERAGE = 'CN_A_SHARES_SH_SZ' as const;
export type AShareSentimentCoverage = typeof A_SHARE_SENTIMENT_COVERAGE;

export type AShareSentimentCapability = 'limit-up' | 'broken-board' | 'themes';

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

export interface AShareSentimentRawSnapshot {
  readonly date: string;
  readonly coverage: AShareSentimentCoverage;
  readonly source: string;
  readonly sealed: AShareSentimentRawPool;
  readonly broken: AShareSentimentRawPool;
}

export interface AShareSentimentSource {
  readonly name: string;
  readonly capabilities: readonly AShareSentimentCapability[];
  fetch(input: {
    readonly date: string;
    readonly coverage: AShareSentimentCoverage;
  }): Promise<AShareSentimentRawSnapshot>;
}
