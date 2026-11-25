import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';
import { projectSampling } from './model-proxy.js';

describe('projectSampling：Agent profile 采样参数 → 供应商请求字段', () => {
  it('温度与推理强度都来自 profile', () => {
    expect(projectSampling({}, { temperature: 0.2, reasoningEffort: 'high' })).toEqual({
      temperature: 0.2,
      reasoning_effort: 'high',
    });
  });

  it('reasoningEffort=off 时不发推理参数', () => {
    expect(projectSampling({}, { temperature: 0.3, reasoningEffort: 'off' })).toEqual({
      temperature: 0.3,
    });
    expect(projectSampling({}, { reasoningEffort: 'off' })).toEqual({});
  });

  it('单次调用显式给出的控制项优先于 profile 默认值', () => {
    expect(
      projectSampling(
        { temperature: 1, reasoningEffort: ReasoningEffortId('low') },
        { temperature: 0.2, reasoningEffort: 'high' },
      ),
    ).toEqual({ temperature: 1, reasoning_effort: 'low' });
  });
});
