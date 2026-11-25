import { afterEach, describe, expect, it } from 'bun:test';
import { createDshIntegrationFixture } from './integration-fixture.js';

const fixtures: Awaited<ReturnType<typeof createDshIntegrationFixture>>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
const setup = async (options: Parameters<typeof createDshIntegrationFixture>[0] = {}) => {
  const fixture = await createDshIntegrationFixture(options);
  fixtures.push(fixture);
  return fixture;
};

/**
 * 回归：agent profile 的采样参数必须一路到达真实供应商请求体。
 * 断言的是 Web → DSH Host → Host ModelProxy → 供应商 fetch 的最终出站 body，
 * 不是某一层 helper 的返回值。
 */
describe('DSH 上游请求携带 agent profile 采样参数', () => {
  it('temperature / reasoning_effort / 输出预算写入供应商请求体', async () => {
    const fixture = await setup({
      modelParams: { temperature: 0.7, reasoningEffort: 'high', maxTokens: 4096 },
    });
    const sessionId = await fixture.createSession();
    const response = await fixture.chat(sessionId, '查 002594 行情');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('"type":"error"');
    expect(fixture.bodies.length).toBeGreaterThan(0);
    expect(fixture.bodies[0]).toMatchObject({
      model: 'deepseek-chat',
      temperature: 0.7,
      reasoning_effort: 'high',
      max_tokens: 4096,
      stream: true,
    });
  }, 30_000);

  it('reasoningEffort=off 时不发推理参数，温度与预算仍然生效', async () => {
    const fixture = await setup({
      modelParams: { temperature: 0.35, reasoningEffort: 'off', maxTokens: 2048 },
    });
    const sessionId = await fixture.createSession();
    const response = await fixture.chat(sessionId, '查 002594 行情');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('"type":"error"');
    expect(fixture.bodies.length).toBeGreaterThan(0);
    const body = fixture.bodies[0] as Record<string, unknown>;
    expect(body.temperature).toBe(0.35);
    expect(body.max_tokens).toBe(2048);
    expect(body).not.toHaveProperty('reasoning_effort');
  }, 30_000);
});
