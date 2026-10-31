// 用户结果回填的 harness 提问接缝（REQ-M3-18 主路径补丁）。
//
// `record_advice_outcome` 的来源戳不能由模型自报：模型能调这个 policy，就能自称 `user`。
// 所以由**插件**在 policy 执行前用 harness 的 `ctx.userQuestions` 亲自问用户四选一，
// 由 harness 返回的答案给 `origin=user` 背书（`AdviceOutcomeOrigin` 见 `@luoome/core`）。
// 用户选「不知道」、答非所问、超时或通道不可用一律不写入：没有兑现事实就没有样本，
// 分母不因一次提问而变化。

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  UserQuestionService,
} from '@deepseek-ai/dsh-user-questions';
import {
  ADVICE_OUTCOME_ANSWER_LABELS,
  ADVICE_OUTCOME_ANSWERS,
  type AdviceOutcomeAnswer,
} from '@luoome/core';

/** 提问的问题 id：答案按 id 回传，插件只认这一个 id。 */
export const ADVICE_OUTCOME_QUESTION_ID = 'luoome-advice-outcome';

/** 用户作答等待上限；超时按「未作答」处理，不写入。 */
export const DEFAULT_ADVICE_OUTCOME_ASK_TIMEOUT_MS = 120_000;

/** 模型已提交、等待用户背书的 outcome（不含 `unknown`：那是回答，不是结果）。 */
export type SubmittedAdviceOutcome = Exclude<AdviceOutcomeAnswer, 'unknown'>;

export interface AdviceOutcomeAskRequest {
  /** 调用方会话的活 Agent：harness 只允许精确的存活顶层 Agent 提问。 */
  readonly agent: Agent;
  /** 工具调用的取消信号：用户取消本次调用即中止提问。 */
  readonly signal: AbortSignal;
  readonly adviceId: string;
  /** 本次 policy 即将写入的 outcome，仅用于提问文案与一致性核对。 */
  readonly outcome: SubmittedAdviceOutcome;
}

/**
 * 提问结果四态：
 * - `user`：用户亲自选了与本次提交一致的结论，写入可盖 `origin=user`；
 * - `declined`：用户本人没背书（选「不知道」/选了别的结论/只写文字），不写入；
 * - `unavailable`：提问通道不可用（无 answerer、子 Agent、超时、异常），不写入；
 * - `not_configured`：宿主根本没有 `ctx.userQuestions` 接缝，保持 `origin=model` 的旧行为。
 */
export type AdviceOutcomeAskResult =
  | { readonly kind: 'user' }
  | { readonly kind: 'declined'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'not_configured' };

export type AdviceOutcomeAsker = (
  request: AdviceOutcomeAskRequest,
) => Promise<AdviceOutcomeAskResult>;

const answerOfLabel = (label: string): AdviceOutcomeAnswer | undefined =>
  ADVICE_OUTCOME_ANSWERS.find((answer) => ADVICE_OUTCOME_ANSWER_LABELS[answer] === label);

/** 四个选项按领域固定顺序与措辞，不预选、不标推荐（REQ-M3-18 §1）。 */
const outcomeQuestion = (request: AdviceOutcomeAskRequest): AskUserQuestionItem => ({
  id: ADVICE_OUTCOME_QUESTION_ID,
  header: '结果回填',
  question: '这条建议的结果是？',
  detail:
    `建议 ${request.adviceId}；本次提交的结论是「${ADVICE_OUTCOME_ANSWER_LABELS[request.outcome]}」` +
    `（outcome=${request.outcome}）。只有你本人选中的结论才会作为用户回填（origin=user）计入命中率；` +
    `选「不知道」不写入。`,
  options: ADVICE_OUTCOME_ANSWERS.map((answer) => ({
    label: ADVICE_OUTCOME_ANSWER_LABELS[answer],
  })),
  multiSelect: false,
});

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  typeof (error as { code?: unknown }).code === 'string'
    ? ((error as { code: string }).code ?? undefined)
    : undefined;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';

const readAnswer = (
  answer: AskUserQuestionAnswer,
  outcome: SubmittedAdviceOutcome,
): AdviceOutcomeAskResult => {
  const item = answer.answers.find((entry) => entry.id === ADVICE_OUTCOME_QUESTION_ID);
  if (item === undefined) return { kind: 'declined', reason: '用户未作答，本次回填未写入' };
  const matched = [...new Set(item.selected.map(answerOfLabel))].filter(
    (entry): entry is AdviceOutcomeAnswer => entry !== undefined,
  );
  if (matched.length !== 1) {
    const custom = item.custom?.trim();
    return {
      kind: 'declined',
      reason:
        custom === undefined || custom.length === 0
          ? '用户的作答不是四个选项之一，本次回填未写入'
          : `用户以文字作答「${custom}」；请先复述成四个选项之一让用户确认后再提交，本次回填未写入`,
    };
  }
  const chosen = matched[0] as AdviceOutcomeAnswer;
  if (chosen === 'unknown')
    return { kind: 'declined', reason: '用户选择「不知道」：按不知道处理，本次回填未写入' };
  if (chosen !== outcome)
    return {
      kind: 'declined',
      reason:
        `用户选择的结论是「${ADVICE_OUTCOME_ANSWER_LABELS[chosen]}」` +
        `（outcome=${chosen}），与本次提交的 outcome=${outcome} 不一致；` +
        '请按用户选择重新提交，本次回填未写入',
    };
  return { kind: 'user' };
};

/**
 * 把一次 `ctx.userQuestions.ask` 收敛成三态结果。
 *
 * 超时不靠 harness 的 timed 通道：那是 `ask_user_question` 工具卡片的语义（callId + 前台认领），
 * 插件提问没有卡片。这里自带上限：超时先 abort 让提问卡片中止，再自己赢下竞速——
 * 回答者即使不理会取消信号（第三方 answerer 完全可能挂住），也不会把工具调用拖死。
 */
const askWithTimeout = async (
  service: Pick<UserQuestionService, 'ask'>,
  request: AdviceOutcomeAskRequest,
  timeoutMs: number,
): Promise<AdviceOutcomeAskResult> => {
  const expiry = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    expiry.abort();
  }, timeoutMs);
  const signal = AbortSignal.any([request.signal, expiry.signal]);
  const pending = service.ask({
    questions: [outcomeQuestion(request)],
    agent: request.agent,
    signal,
  });
  // 竞速输掉之后不再有人 await 这个 promise：挂一个吞掉的 handler，避免 unhandled rejection。
  pending.catch(() => {});
  const expiryError = () => {
    const error = new Error(timedOut ? 'user question expired' : 'user question cancelled');
    return Object.assign(error, { code: timedOut ? 'ASK_TIMED_OUT' : 'ASK_ABORTED' });
  };
  const deadline = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(expiryError());
    else
      signal.addEventListener('abort', () => reject(expiryError()), {
        once: true,
      });
  });
  try {
    return readAnswer(await Promise.race([pending, deadline]), request.outcome);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'NO_PROVIDER')
      return {
        kind: 'unavailable',
        reason: '当前宿主没有可用的用户提问通道（userQuestions NO_PROVIDER），本次回填未写入',
      };
    if (code === 'DELEGATED_CALLER')
      return {
        kind: 'unavailable',
        reason: '子 Agent 不能向用户提问；请把这次回填交回顶层会话，本次回填未写入',
      };
    if (code === 'CALLER_NOT_LIVE')
      return {
        kind: 'unavailable',
        reason: '提问需要存活的顶层会话（CALLER_NOT_LIVE），本次回填未写入',
      };
    if (code === 'ASK_ABORTED' || request.signal.aborted || timedOut)
      return {
        kind: 'unavailable',
        reason: timedOut
          ? `等待用户作答超时（${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`}），本次回填未写入`
          : '提问已被取消，本次回填未写入',
      };
    return {
      kind: 'unavailable',
      reason: `用户提问失败（${code ?? 'unknown'}）：${errorMessage(error)}；本次回填未写入`,
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 用宿主的 `ctx.userQuestions` 构造提问器。
 *
 * 服务在**每次提问时**解析，而不是装配时缓存：DSH 的插件装配顺序不保证
 * `userQuestions` 已经挂载，装配时取不到就永久降级成 `origin=model`，那正是本补丁要修的
 * 主路径缺陷。宿主确实没有该接缝时返回 `not_configured`，调用方据此保持旧行为。
 */
export const adviceOutcomeAskerOf = (
  ctx: Context,
  options: { readonly timeoutMs?: number } = {},
): AdviceOutcomeAsker => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ADVICE_OUTCOME_ASK_TIMEOUT_MS;
  return (request) => {
    const service = ctx.get('userQuestions') as Pick<UserQuestionService, 'ask'> | undefined;
    return service === undefined
      ? Promise.resolve({ kind: 'not_configured' as const })
      : askWithTimeout(service, request, timeoutMs);
  };
};
