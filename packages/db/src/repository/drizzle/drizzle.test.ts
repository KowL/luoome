import { createDrizzleRepos } from '../../client.js';
import { registerRepositoryContractTests } from '../contract-tests.js';
import type { DrizzleAdviceRepository } from './index.js';

/** Drizzle 实现（bun:sqlite :memory:）跑完整契约套件。 */
registerRepositoryContractTests('drizzle', () => {
  const handle = createDrizzleRepos(':memory:');
  return {
    repos: handle.repos,
    readOutcome: (adviceId: string) =>
      (handle.repos.advice as DrizzleAdviceRepository).getOutcome(adviceId),
    close: handle.close,
  };
});
