import { afterEach, describe, expect, it } from 'bun:test';
import { createDshIntegrationFixture } from './integration-fixture.js';
import { ModelBudgetLedger } from './model-budget.js';
import { CLOSED_DSH_ROLLOUT, DshRolloutGate, dshRolloutBucket } from './rollout.js';
import { DshRuntimeControl } from './run-control.js';

const fixtures: Awaited<ReturnType<typeof createDshIntegrationFixture>>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
const setup = async (options: Parameters<typeof createDshIntegrationFixture>[0] = {}) => {
  const fixture = await createDshIntegrationFixture(options);
  fixtures.push(fixture);
  return fixture;
};
const parse = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);

const streamErrors = (chunks: Record<string, unknown>[]) =>
  chunks
    .filter((part) => part.type === 'data-luoome-stream-error')
    .map((part) => (part.data as { message: string }).message);

describe('DSH 预算、排空与灰度（受控供应商）', () => {
  it('预算耗尽后拒绝下一次 attempt，失败不重跑也不虚构成功', async () => {
    const ledger = new ModelBudgetLedger({
      maxTokens: 60,
      maxRequests: 50,
      windowMs: 3_600_000,
    });
    const fixture = await setup({ budget: ledger });
    const sessionId = await fixture.createSession();
    const chunks = parse(
      await (await fixture.chat(sessionId, '查 002594 行情并读取网页来源')).text(),
    );
    // 每次供应商 attempt 结算 30 token：第 3 次调用在发出前被账本拒绝。
    expect(fixture.bodies).toHaveLength(2);
    expect(streamErrors(chunks)).toEqual([expect.stringContaining('模型调用预算已用尽')]);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'data-luoome-run',
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
    expect(ledger.snapshot('account-default')).toMatchObject({
      tokensUsed: 60,
      tokensReserved: 0,
      requests: 2,
      unknownAttempts: 0,
    });

    const next = await fixture.chat(sessionId, '请重新查一次 002594 行情');
    const nextChunks = parse(await next.text());
    expect(streamErrors(nextChunks)).toEqual([expect.stringContaining('模型调用预算已用尽')]);
    expect(fixture.bodies).toHaveLength(2);
  }, 60_000);

  it('排空期间拒绝新 run，在途 run 排空后新配置生效', async () => {
    const control = new DshRuntimeControl();
    const fixture = await setup({ control });
    const sessionId = await fixture.createSession();
    const abort = new AbortController();
    const response = await fixture.chat(sessionId, '慢速查 002594 行情', abort.signal);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('missing stream');
    const decoder = new TextDecoder();
    let body = '';
    while (!body.includes('"type":"text-delta"')) {
      const next = await reader.read();
      if (next.done) throw new Error(`missing partial text: ${body}`);
      body += decoder.decode(next.value, { stream: true });
    }
    expect(control.activeRuns()).toBe(1);

    const drain = control.beginDrain('配置升级');
    expect(drain.activeRuns).toBe(1);
    const otherSession = await fixture.createSession();
    const rejected = await fixture.chat(otherSession, '继续研究');
    expect(rejected.status).toBe(503);
    expect(((await rejected.json()) as { error: { cause: string } }).error.cause).toContain('排空');
    // 超时得到确定结果：仍在途，不声称排空完成。
    expect(await control.waitForIdle(50)).toBe(false);
    expect(fixture.bodies).toHaveLength(1);

    abort.abort();
    try {
      while (!(await reader.read()).done) {}
    } catch {
      /* 客户端断开。 */
    }
    expect(await control.waitForIdle(15_000)).toBe(true);
    const drained = await fixture.context.repos.agentSessionBinding.findByConversation(sessionId);
    expect(drained).toMatchObject({
      status: 'interrupted',
      dshSessionId: null,
      pendingRunId: null,
    });
    control.resume();

    // 新组合：新 runtime 实例 + 不同模型配置，仅影响后续请求。
    const restarted = fixture.restart({ maxTokens: 2048 });
    const resumed = await restarted.chat(sessionId, '继续刚才的研究');
    expect(resumed.status).toBe(200);
    const chunks = parse(await resumed.text());
    expect(chunks.filter((part) => part.type === 'error')).toEqual([]);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'data-luoome-runtime',
        data: expect.objectContaining({ contextMode: 'rebuilt-history' }),
      }),
    );
    const binding = await fixture.context.repos.agentSessionBinding.findByConversation(sessionId);
    expect(binding?.status).toBe('active');
    expect(binding?.configHash).not.toBe(drained?.configHash);
    expect(control.status()).toMatchObject({ accepting: true, activeRuns: 0 });
  }, 60_000);

  it('灰度按 allowlist 与稳定哈希命中，关闭开关后新请求不再进入 DSH', async () => {
    const gate = new DshRolloutGate({
      enabled: true,
      accountAllowlist: ['account-default'],
      percent: 0,
    });
    const fixture = await setup({ rollout: gate });
    const sessionId = await fixture.createSession();
    await (await fixture.chat(sessionId, '查 002594 行情')).text();
    const accepted = fixture.bodies.length;
    expect(accepted).toBeGreaterThanOrEqual(1);

    gate.update({ ...CLOSED_DSH_ROLLOUT });
    const blocked = await fixture.chat(sessionId, '继续研究');
    expect(blocked.status).toBe(503);
    expect(((await blocked.json()) as { error: { cause: string } }).error.cause).toContain('灰度');
    expect(fixture.bodies).toHaveLength(accepted);

    const bucket = dshRolloutBucket('account-default');
    gate.update({ enabled: true, accountAllowlist: [], percent: bucket });
    const excluded = await fixture.chat(sessionId, '继续研究');
    expect(excluded.status).toBe(503);
    gate.update({ enabled: true, accountAllowlist: [], percent: bucket + 1 });
    const included = await fixture.chat(sessionId, '继续研究');
    expect(included.status).toBe(200);
    expect(parse(await included.text()).filter((part) => part.type === 'error')).toEqual([]);
  }, 60_000);
});
