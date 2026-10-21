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
