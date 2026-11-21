import { describe, expect, it } from 'bun:test';
import { DshChatProjection, type UIStreamPart } from './chat-projection.js';

const setup = () => {
  const chunks: UIStreamPart[] = [];
  const projection = new DshChatProjection(
    'assistant-fixture',
    (part) => chunks.push(part),
    new Set(['fetch_quote', 'create_watchlist']),
  );
  return {
    chunks,
    projection,
    text: () =>
      chunks
        .filter((part) => part.type === 'text-delta')
        .map((part) => part.delta)
        .join(''),
  };
};

describe('DSH product stream projection (pure fixtures)', () => {
  it('reconciles a durable full message without appending the streamed prefix twice', () => {
    const { projection, text, chunks } = setup();
    projection.textDelta('attempt-1/message-1', '行情');
    expect(text()).toBe('行情');
    projection.durableText('attempt-1/message-1', '行情事实');
    projection.durableText('attempt-1/message-1', '行情事实');
    projection.textDelta('attempt-1/message-1', '事实');
    projection.end();
    expect(text()).toBe('行情事实');
    expect(projection.parts).toEqual([{ type: 'text', text: '行情事实' }]);
    expect(chunks.filter((part) => part.type === 'text-end')).toHaveLength(1);
  });

  it('keeps separate attempts distinct and preserves text around tool calls', () => {
    const { projection, text } = setup();
    projection.textDelta('attempt-1/message-1', '先查');
    projection.toolCall('call-1', 'fetch_quote', { stockId: '002594.SZ' });
    projection.toolResult('call-1', true, { close: 250 });
    projection.durableText('attempt-1/message-1', '先查');
    projection.textDelta('attempt-2/message-1', '再解释');
    projection.durableText('attempt-2/message-1', '再解释');
    expect(text()).toBe('先查再解释');
    expect(projection.parts.map((part) => part.type)).toEqual(['text', 'tool-fetch_quote', 'text']);
  });

  it('never publishes hidden reasoning split across chunks or in durable content', () => {
    const { projection, text } = setup();
    for (const delta of ['<th', 'ink>secret', '</thi', 'nk>结', '论'])
      projection.textDelta('m1', delta);
    projection.durableText('m1', '<think>secret</think>结论');
    projection.durableText('m2', '<think>more private reasoning</think>来源');
    expect(text()).toBe('结论来源');
    expect(JSON.stringify(projection.parts)).not.toContain('secret');
    expect(JSON.stringify(projection.parts)).not.toContain('private');
  });

  it('preserves draft and business error facts with one card per call', () => {
    const { projection, chunks } = setup();
    const input = { name: '测试列表' };
    const draft = {
      __luoomeDraft: true,
      draft: { tool: 'create_watchlist', kind: 'watchlist', input },
    };
    projection.toolCall('draft', 'create_watchlist', input);
    projection.toolCall('draft', 'create_watchlist', input);
    projection.toolResult('draft', true, draft);
    projection.toolResult('draft', true, draft);
    projection.toolCall('read', 'fetch_quote', {});
    const error = { error: { kind: 'not_found', entity: 'Stock', id: 'fixture' } };
    projection.toolResult('read', false, error);
    expect(chunks.filter((part) => part.type === 'tool-input-available')).toHaveLength(2);
    expect(projection.parts[0]).toMatchObject({ state: 'output-available', output: draft });
    expect(projection.parts[1]).toMatchObject({ output: error });
  });

  it('omits oversized tool payloads instead of failing the final assistant response', () => {
    const { projection, chunks } = setup();
    for (let index = 0; index < 8; index++) {
      const callId = `call-${index}`;
      projection.toolCall(callId, 'fetch_quote', {});
      projection.toolResult(callId, true, { data: 'x'.repeat(60_000) });
    }
    projection.toolCall('call-advice', 'fetch_quote', {});
    projection.toolResult('call-advice', true, { data: 'x'.repeat(141_751) });
    projection.toolResult('call-advice', true, { data: 'x'.repeat(141_751) });
    projection.durableText('final', '已核对可用事实，并说明数据缺口。');
    projection.end();

    const part = projection.parts.find((part) => part.toolCallId === 'call-advice');
    expect(part).toMatchObject({
      state: 'output-available',
      output: { __luoomeOutputOmitted: true },
    });
    expect(chunks.some((part) => part.type === 'error')).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(projection.parts))).toBeLessThan(524_288);
  });

  it('bounds accumulated tool payloads while retaining every tool receipt', () => {
    const { projection } = setup();
    for (let index = 0; index < 9; index++) {
      const callId = `call-${index}`;
      projection.toolCall(callId, 'fetch_quote', {});
      projection.toolResult(callId, true, { data: 'x'.repeat(50_000) });
    }
    expect(projection.parts.filter((part) => part.type === 'tool-fetch_quote')).toHaveLength(9);
    expect(
      projection.parts.some(
        (part) =>
          typeof part.output === 'object' &&
          part.output !== null &&
          '__luoomeOutputOmitted' in part.output,
      ),
    ).toBe(true);
    expect(() => projection.durableText('final', '回答已保存。')).not.toThrow();
  });

  it('rejects conflicting durable text, changed calls, unsolicited results and excessive output', () => {
    const { projection } = setup();
    projection.textDelta('m1', '真实');
    expect(() => projection.durableText('m1', '另一内容')).toThrow('reconciliation');
    projection.toolCall('call', 'fetch_quote', {});
    expect(() => projection.toolCall('call', 'create_watchlist', {})).toThrow('conflicting');
    expect(() => projection.toolCall('foreign', 'settle_chat_draft', {})).toThrow('unbound');
    expect(() => projection.toolResult('foreign', true, {})).toThrow('without bound call');
    expect(() => projection.textDelta('huge', 'x'.repeat(524_289))).toThrow('limit');
  });
});
