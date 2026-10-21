import type { SideEffect, ToolError } from '@luoome/core';

export interface GatewayIdentity {
  readonly tenantId: string;
  readonly tenantGeneration: number;
  readonly accountId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
}

export interface GatewayScopeSnapshot extends GatewayIdentity {
  readonly audience: string;
  readonly manifestHash: string;
  readonly scenario: string;
  readonly expiresAt: number;
  readonly allowedCapabilities: readonly SideEffect[];
  readonly budgetOperationId?: string;
}

/** Supplied by authenticated server transport, never decoded from model tool arguments. */
export interface GatewayCaller extends GatewayIdentity {
  readonly audience: string;
}

export const gatewayDenied = (required: string): ToolError => ({
  kind: 'permission_denied',
  required: `dsh-gateway:${required}`,
});

export class GatewayExecutionScope {
  readonly snapshot: GatewayScopeSnapshot;
  readonly #controller = new AbortController();

  constructor(snapshot: GatewayScopeSnapshot) {
    this.snapshot = Object.freeze({
      ...snapshot,
      allowedCapabilities: Object.freeze([...snapshot.allowedCapabilities]),
    });
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  revoke(): void {
    this.#controller.abort();
  }

  check(caller: GatewayCaller, now: number): ToolError | null {
    if (this.signal.aborted) return gatewayDenied('scope-revoked');
    if (now >= this.snapshot.expiresAt) return gatewayDenied('scope-expired');
    const keys = [
      'tenantId',
      'tenantGeneration',
      'accountId',
      'conversationId',
      'runId',
      'runtimeInstanceId',
      'sessionId',
      'audience',
    ] as const;
    if (keys.some((key) => caller[key] !== this.snapshot[key])) {
      return gatewayDenied('scope-binding');
    }
    return null;
  }
}
