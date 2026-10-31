// 提问接缝的单元口径：四个选项必须与领域一致，答案映射不能把「不知道」或没作答当成回填。
import type { Agent } from '@deepseek-ai/dsh-agent';
import { describe, expect, it } from 'vitest';
import {
  ADVICE_OUTCOME_QUESTION_ID,
  adviceOutcomeAskerOf,
  DEFAULT_ADVICE_OUTCOME_ASK_TIMEOUT_MS,
} from './advice-outcome-ask.js';

const agent = {} as Agent;
const signal = () => new AbortController().signal;

/** 记录一次提问并回放预设答案的假服务：只实现 `ask`，形状与 `ctx.userQuestions` 一致。 */
const serviceReturning = (
  answer: unknown,
): {
  readonly calls: { questions: unknown[]; agent: Agent }[];
  ask: (request: unknown) => Promise<never>;
} => {
  const calls: { questions: unknown[]; agent: Agent }[] = [];
  return {
    calls,
    ask: async (request) => {
      calls.push(request as { questions: unknown[]; agent: Agent });
      if (answer instanceof Error) throw answer;
      return answer as never;
    },
  };
};

const askerFor = (service: unknown) =>
  adviceOutcomeAskerOf({
    get: (name: string) => (name === 'userQuestions' ? service : undefined),
  } as never);

const questionOf = (service: ReturnType<typeof serviceReturning>) =>
  service.calls[0]?.questions[0] as {
    id: string;
    question: string;
    detail?: string;
    multiSelect?: boolean;
    options: { label: string; description?: string }[];
  };

const answered = (label: string) => ({
  answers: [{ id: ADVICE_OUTCOME_QUESTION_ID, selected: [label] }],
});

describe('advice outcome 提问接缝', () => {
  it('宿主没有 userQuestions → not_configured（调用方保持 origin=model 的旧行为）', async () => {
    const asker = adviceOutcomeAskerOf({ get: () => undefined } as never);
    await expect(
      asker({ agent, signal: signal(), adviceId: 'advice-1', outcome: 'followed' }),
    ).resolves.toEqual({ kind: 'not_configured' });
  });

  it('服务在装配之后才挂载也能提问（每次提问时解析）', async () => {
    let service: unknown;
    const ctx = { get: (name: string) => (name === 'userQuestions' ? service : undefined) };
    const asker = adviceOutcomeAskerOf(ctx as never);
    await expect(
      asker({ agent, signal: signal(), adviceId: 'advice-1', outcome: 'followed' }),
    ).resolves.toEqual({ kind: 'not_configured' });
    service = serviceReturning(answered('兑现'));
    await expect(
      asker({ agent, signal: signal(), adviceId: 'advice-1', outcome: 'followed' }),
    ).resolves.toEqual({ kind: 'user' });
  });

  it('问题恰好是四个选项，按领域顺序，不预选也不标推荐', async () => {
    const service = serviceReturning(answered('兑现'));
    const asker = askerFor(service);
    const result = await asker({
      agent,
      signal: signal(),
      adviceId: 'advice-1',
      outcome: 'followed',
    });
    expect(result).toEqual({ kind: 'user' });
    const question = questionOf(service);
    expect(question.id).toBe(ADVICE_OUTCOME_QUESTION_ID);
    expect(question.options.map((option) => option.label)).toEqual([
      '兑现',
      '部分兑现',
      '忽略',
      '不知道',
    ]);
    expect(question.multiSelect).toBe(false);
    expect(JSON.stringify(question)).not.toContain('Recommended');
    expect(question.detail).toContain('origin=user');
  });

  it('选「不知道」→ declined，不写入', async () => {
    const asker = askerFor(serviceReturning(answered('不知道')));
    const result = await asker({
      agent,
      signal: signal(),
      adviceId: 'advice-1',
      outcome: 'followed',
    });
    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toContain('不知道');
  });

  it('选了与提交不一致的结论 → declined，并同时给出标签与 outcome 值', async () => {
    const asker = askerFor(serviceReturning(answered('部分兑现')));
    const result = await asker({
      agent,
      signal: signal(),
      adviceId: 'advice-1',
      outcome: 'followed',
    });
    expect(result.kind).toBe('declined');
    const reason = result.kind === 'declined' ? result.reason : '';
    expect(reason).toContain('部分兑现');
    expect(reason).toContain('partially_followed');
  });

  it('只写文字、没选选项 → declined，要求先复述成选项确认', async () => {
    const asker = askerFor(
      serviceReturning({
        answers: [{ id: ADVICE_OUTCOME_QUESTION_ID, selected: [], custom: '大概跟了' }],
      }),
    );
    if (asker === undefined) throw new Error('missing asker');
    const result = await asker({
      agent,
      signal: signal(),
      adviceId: 'advice-1',
      outcome: 'followed',
    });
    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toContain('大概跟了');
  });

  it('答案里没有本问题 id → declined', async () => {
    const asker = askerFor(serviceReturning({ answers: [{ id: 'other', selected: ['兑现'] }] }));
    const result = await asker({
      agent,
      signal: signal(),
      adviceId: 'advice-1',
      outcome: 'followed',
    });
    expect(result.kind).toBe('declined');
  });

  it.each([
    ['NO_PROVIDER', 'NO_PROVIDER'],
    ['DELEGATED_CALLER', '子 Agent'],
    ['CALLER_NOT_LIVE', 'CALLER_NOT_LIVE'],
  ])('harness 错误 %s → unavailable 且原因可见', async (code, expected) => {
    const error = Object.assign(new Error('synthetic'), { code });
    const asker = askerFor(serviceReturning(error));
    const result = await asker({
      agent,
      signal: signal(),
      adviceId: 'advice-1',
      outcome: 'followed',
    });
    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain(expected);
  });

  it('调用已取消 → unavailable，不落成 user', async () => {
    const controller = new AbortController();
    controller.abort();
    const asker = askerFor(serviceReturning(new Error('never reached')));
    const result = await asker({
      agent,
      signal: controller.signal,
      adviceId: 'advice-1',
      outcome: 'followed',
    });
    expect(result.kind).toBe('unavailable');
  });

  it('默认等待上限是 120 秒（与 ask_user_question 的默认时长一致）', () => {
    expect(DEFAULT_ADVICE_OUTCOME_ASK_TIMEOUT_MS).toBe(120_000);
  });
});
