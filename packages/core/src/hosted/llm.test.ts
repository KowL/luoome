import { describe, expect, it } from 'vitest';
import { hostedLLMCost } from './llm.js';

const pricing = {
  version: 'fixture',
  provider: 'deepseek',
  model: 'deepseek-flash',
  currency: 'CNY' as const,
  inputMicroPerMillion: 2_000_000,
  cachedInputMicroPerMillion: 40_000,
  outputMicroPerMillion: 8_000_000,
};
describe('hosted token cost', () => {
  it('分别计算缓存/非缓存输入和输出，按微元向上取整', () => {
    expect(hostedLLMCost({ input: 1000, cachedInput: 200, output: 500 }, pricing)).toBe(5608);
    expect(hostedLLMCost({ input: 1, cachedInput: 1, output: 0 }, pricing)).toBe(1);
    expect(hostedLLMCost({ input: 0, cachedInput: 0, output: 0 }, pricing)).toBe(0);
  });
  it('拒绝无效 token/价格与数值溢出，不用零掩盖缺失', () => {
    expect(() => hostedLLMCost({ input: 1, cachedInput: 2, output: 0 }, pricing)).toThrow();
    expect(() => hostedLLMCost({ input: 0, cachedInput: 0, output: -1 }, pricing)).toThrow();
    expect(() =>
      hostedLLMCost({ input: Number.MAX_SAFE_INTEGER, cachedInput: 0, output: 0 }, pricing),
    ).toThrow('overflow');
  });
});
