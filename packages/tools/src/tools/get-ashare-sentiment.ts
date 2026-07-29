import {
  AShareSentimentSnapshotSchema,
  assertAShareSentimentSnapshotInvariants,
  type DataProvenance,
  dateInShanghai,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';

export const GetAShareSentimentInput = z.object({
  date: z.string().date(),
  includeIndexes: z.boolean().default(true),
  includeBreadth: z.boolean().default(true),
});

export const GetAShareSentimentOutput = z.object({
  snapshot: AShareSentimentSnapshotSchema,
});

const unavailable = (
  provider: string,
  now: Date,
  errorKind: string,
  message: string,
): {
  status: 'unavailable';
  provenance: DataProvenance[];
  warnings: string[];
} => ({
  status: 'unavailable',
  provenance: [
    {
      provider,
      observedAt: now,
      fetchedAt: now,
      freshness: 'unavailable',
      errorKind,
      errorMessage: message.slice(0, 300),
    },
  ],
  warnings: [message],
});

export const getAShareSentimentTool = defineTool({
  name: 'get_ashare_sentiment',
  description:
    '获取指定沪深 A 股交易日的指数、市场宽度、封板/炸板/连板/封单与热点情绪证据；各维度独立标注完整性和溯源。',
  sideEffect: 'external',
  input: GetAShareSentimentInput,
  output: GetAShareSentimentOutput,
  handler: async (input, ctx) => {
    if (ctx.ashareSentiment === undefined) {
      return errInvalidInput('get_ashare_sentiment 需要注入 A 股情绪 manager');
    }
    const result = await ctx.ashareSentiment.fetch({
      date: input.date,
      coverage: 'CN_A_SHARES_SH_SZ',
    });
    if (!result.ok) {
      if (result.error.kind === 'invalid_input') return errInvalidInput(result.error.message);
      return errAdapterError('ashare-sentiment', result.error.message, result.error.recoverable);
    }

    const now = ctx.clock();
    const indexes = input.includeIndexes
      ? await fetchIndexesForDate(input.date, now, ctx.adapters.market)
      : unavailable('luoome/market-index', now, 'not_requested', 'index quotes not requested');
    const breadth = input.includeBreadth
      ? result.data.breadth
      : unavailable('luoome/market-snapshot', now, 'not_requested', 'market breadth not requested');
    const dataAsOf =
      indexes.status === 'complete' && indexes.values.length > 0
        ? new Date(
            Math.min(
              result.data.dataAsOf.getTime(),
              ...indexes.values.map((quote) => quote.ts.getTime()),
            ),
          )
        : result.data.dataAsOf;
    const snapshot = AShareSentimentSnapshotSchema.parse({
      ...result.data,
      dataAsOf,
      indexes,
      breadth,
    });
    assertAShareSentimentSnapshotInvariants(snapshot);
    return { snapshot };
  },
});

const fetchIndexesForDate = async (
  date: string,
  now: Date,
  market: {
    readonly name: string;
    fetchIndexQuotes(): Promise<
      readonly {
        readonly code: string;
        readonly name: string;
        readonly close: number & { readonly __brand: 'Money' };
        readonly change: number;
        readonly changePct: number;
        readonly ts: Date;
        readonly source: string;
      }[]
    >;
  },
) => {
  try {
    const values = [...(await market.fetchIndexQuotes())];
    if (values.some((quote) => dateInShanghai(quote.ts) !== date)) {
      return unavailable(
        market.name,
        now,
        'date_mismatch',
        'index quote observed date does not match requested date',
      );
    }
    const observedAt =
      values.length === 0 ? now : new Date(Math.min(...values.map((quote) => quote.ts.getTime())));
    return {
      status: 'complete' as const,
      provenance: [
        {
          provider: market.name,
          observedAt,
          fetchedAt: now,
          freshness: 'fresh' as const,
        },
      ],
      warnings: [],
      values,
    };
  } catch (error) {
    return unavailable(
      market.name,
      now,
      'adapter_error',
      error instanceof Error ? error.message : String(error),
    );
  }
};
