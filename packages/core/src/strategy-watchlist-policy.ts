import { InvariantError } from './error/index.js';

export const assertStrategySelectionPolicy = (input: {
  readonly origin: 'builtin' | 'migration' | 'user';
  readonly selectionRuleCount: number;
}): void => {
  if (!Number.isInteger(input.selectionRuleCount) || input.selectionRuleCount < 0) {
    throw new InvariantError('selectionRuleCount 必须是非负整数');
  }
  if (input.origin === 'user' && input.selectionRuleCount === 0) {
    throw new InvariantError('普通用户 Strategy 至少需要一条 selection rule');
  }
};
