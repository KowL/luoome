import { registerRepositoryContractTests } from '../contract-tests.js';
import { createInMemoryRepos, type InMemoryAdviceRepository } from './index.js';

/** in-memory 实现跑完整契约套件。 */
registerRepositoryContractTests('memory', () => {
  const repos = createInMemoryRepos();
  return {
    repos,
    readOutcome: (adviceId: string) =>
      (repos.advice as InMemoryAdviceRepository).getOutcome(adviceId),
  };
});
