import { registerMarketDumpContractTests } from '../market-dump.contract-tests.js';
import { createInMemoryRepos } from './index.js';

/** in-memory 实现跑同一套 market dump 契约（vitest 与 bun test 均可执行）。 */
registerMarketDumpContractTests('memory', () => {
  const repos = createInMemoryRepos();
  return {
    repos: {
      marketDumpRun: repos.marketDumpRun,
      rawDailyBar: repos.rawDailyBar,
      corporateActionEvent: repos.corporateActionEvent,
    },
  };
});
