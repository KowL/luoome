import { describe, expect, it } from 'vitest';
import {
  type GatewayCaller,
  GatewayExecutionScope,
  type GatewayScopeSnapshot,
} from './execution-scope.js';

const snapshot: GatewayScopeSnapshot = {
  tenantId: 'tenant-1',
  tenantGeneration: 3,
  accountId: 'account-1',
  conversationId: 'conversation-1',
  runId: 'run-1',
  runtimeInstanceId: 'runtime-1',
  sessionId: 'agent-session-1',
  audience: 'tools',
  scenario: 'research',
  manifestHash: `sha256:${'a'.repeat(64)}`,
  expiresAt: 2_000,
  allowedCapabilities: ['read', 'external'],
};

describe('GatewayExecutionScope', () => {
  it('binds a private immutable snapshot and expires at the exact boundary', () => {
    const scope = new GatewayExecutionScope(snapshot);
    expect(scope.check(snapshot, 1_999)).toBeNull();
    expect(scope.check(snapshot, 2_000)?.kind).toBe('permission_denied');
    expect(Object.isFrozen(scope.snapshot)).toBe(true);
    expect(Object.isFrozen(scope.snapshot.allowedCapabilities)).toBe(true);
  });

  it.each([
    ['tenantId', 'tenant-2'],
    ['tenantGeneration', 4],
    ['accountId', 'account-2'],
    ['conversationId', 'conversation-2'],
    ['runId', 'run-2'],
    ['runtimeInstanceId', 'runtime-2'],
    ['sessionId', 'agent-session-2'],
    ['audience', 'models'],
  ] as const)('rejects a transport identity with different %s', (key, value) => {
    const scope = new GatewayExecutionScope(snapshot);
    const caller = { ...snapshot, [key]: value } as GatewayCaller;
    expect(scope.check(caller, 1_000)?.kind).toBe('permission_denied');
  });

  it('revokes synchronously and signals pending trusted admission work', () => {
    const scope = new GatewayExecutionScope(snapshot);
    scope.revoke();
    scope.revoke();
    expect(scope.signal.aborted).toBe(true);
    expect(scope.check(snapshot, 1_000)?.kind).toBe('permission_denied');
  });
});
