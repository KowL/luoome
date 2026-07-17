import { describe, expect, it } from 'vitest';

import type { ToolError } from '../error/index.js';
import { Err, Ok, type Result, type ToolResult } from './result.js';

describe('Result', () => {
  it('Ok wraps a value', () => {
    const r: Result<number, string> = Ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('Err wraps an error', () => {
    const r: Result<number, string> = Err('boom');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('boom');
  });
});

describe('ToolResult', () => {
  it('success branch carries data', () => {
    const r: ToolResult<{ n: number }> = { ok: true, data: { n: 1 } };
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.n).toBe(1);
  });

  it('failure branch carries a ToolError discriminated union', () => {
    const errors: ToolError[] = [
      { kind: 'invalid_input', message: 'bad', issues: [] },
      { kind: 'not_found', entity: 'Holding', id: 'h1' },
      { kind: 'invariant_violation', message: 'quantity < 0' },
      { kind: 'adapter_error', adapter: 'eastmoney', cause: 'timeout', recoverable: true },
      { kind: 'permission_denied', required: 'write' },
      { kind: 'llm_error', provider: 'mock', cause: 'overloaded', retryable: true },
      { kind: 'internal', cause: 'bug' },
    ];
    for (const error of errors) {
      const r: ToolResult<never> = { ok: false, error };
      expect(r.ok).toBe(false);
    }
    expect(errors).toHaveLength(7);
  });
});
