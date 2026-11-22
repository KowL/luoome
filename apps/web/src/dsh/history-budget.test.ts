import { expect, it } from 'bun:test';
import { boundTrustedHistory } from './history-budget.js';

const toolMessage = (output: unknown, extraParts: unknown[] = []) => [
  {
    id: 'assistant-1',
    role: 'assistant',
    parts: [
      { type: 'tool-list_watch_plans', toolCallId: 'call-1', state: 'output-available', output },
      ...extraParts,
    ],
  },
];

it('truncates a tool output that would exceed the host prompt cap', () => {
  const output = { plans: 'x'.repeat(300_000) };
  const history = toolMessage(output);
  const result = boundTrustedHistory(history);
  expect(result.overflow).toBe(false);
  expect(result.truncatedParts).toBe(1);
  expect(JSON.stringify(result.history).length).toBeLessThanOrEqual(180_000);

  const part = (result.history[0] as { parts: Record<string, unknown>[] }).parts[0] as {
    type: string;
    toolCallId: string;
    state: string;
    output: { truncated?: boolean; originalCharacters?: number; note?: string };
  };
  expect(part.type).toBe('tool-list_watch_plans');
  expect(part.toolCallId).toBe('call-1');
  expect(part.state).toBe('output-available');
  expect(part.output.truncated).toBe(true);
  expect(part.output.originalCharacters).toBeGreaterThan(300_000);
  expect(part.output.note).toContain('重新调用');
  expect((history[0] as { parts: { output: unknown }[] }).parts[0]?.output).toBe(output);
});

it('leaves a history that fits unchanged', () => {
  const history = [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '看看我的持仓' }] }];
  const result = boundTrustedHistory(history);
  expect(result).toEqual({ history, truncatedParts: 0, overflow: false });
});

it('keeps the newest tool results when the total budget is exceeded', () => {
  const parts = Array.from({ length: 30 }, (_, index) => ({
    type: `tool-fixture_${index}`,
    toolCallId: `call-${index}`,
    state: 'output-available',
    output: { rows: 'x'.repeat(11_000) },
  }));
  const history = [{ id: 'assistant-1', role: 'assistant', parts }];
  const result = boundTrustedHistory(history);
  expect(result.overflow).toBe(false);
  expect(result.truncatedParts).toBeGreaterThan(0);
  expect(JSON.stringify(result.history).length).toBeLessThanOrEqual(180_000);
  const boundedParts = (result.history[0] as { parts: Record<string, unknown>[] }).parts;
  expect(boundedParts[0]?.output).toMatchObject({ truncated: true });
  expect(boundedParts.at(-1)?.output).not.toMatchObject({ truncated: true });
});

it('flags a text-only history that still exceeds the budget', () => {
  const history = [
    { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'x'.repeat(200_000) }] },
  ];
  const result = boundTrustedHistory(history);
  expect(result.overflow).toBe(true);
  expect(result.truncatedParts).toBe(0);
});
