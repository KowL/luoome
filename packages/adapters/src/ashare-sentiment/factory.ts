import type { AShareSentimentManagerLike, Logger } from '@luoome/core';
import { z } from 'zod';

import { EastmoneyAShareSentimentAdapter } from './eastmoney.js';
import { AShareSentimentManager } from './manager.js';

export interface CreateAShareSentimentManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

export const createAShareSentimentManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateAShareSentimentManagerDeps,
): AShareSentimentManagerLike => {
  const configured = env.LUOOME_ASHARE_SENTIMENT_SOURCES?.trim();
  const [source] = z
    .tuple([z.literal('eastmoney')], {
      error: 'A 股情绪当前必须且只能启用 eastmoney',
    })
    .parse(
      configured === undefined || configured.length === 0
        ? ['eastmoney']
        : configured.split(',').map((value) => value.trim().toLowerCase()),
    );
  const clock = deps.clock ?? (() => new Date());
  switch (source) {
    case 'eastmoney':
      return new AShareSentimentManager({
        sources: [new EastmoneyAShareSentimentAdapter(deps.fetchImpl, undefined, clock)],
        clock,
        logger: deps.logger,
      });
  }
};
