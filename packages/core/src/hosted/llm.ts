import { z } from 'zod';
import type { ProviderAttempt, UsageReservation } from './platform.js';

const Count = z.number().int().nonnegative().safe();
export const HostedLLMPricingSchema = z.object({
  version: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  currency: z.literal('CNY'),
  inputMicroPerMillion: Count,
  cachedInputMicroPerMillion: Count,
  outputMicroPerMillion: Count,
});
export type HostedLLMPricing = z.infer<typeof HostedLLMPricingSchema>;
export const HostedLLMTokensSchema = z
  .object({ input: Count, cachedInput: Count, output: Count })
  .refine((value) => value.cachedInput <= value.input, 'cached input exceeds input');
export type HostedLLMTokens = z.infer<typeof HostedLLMTokensSchema>;
export const hostedLLMCost = (tokens: HostedLLMTokens, pricing: HostedLLMPricing): number => {
  HostedLLMTokensSchema.parse(tokens);
  HostedLLMPricingSchema.parse(pricing);
  const value =
    (BigInt(tokens.input - tokens.cachedInput) * BigInt(pricing.inputMicroPerMillion) +
      BigInt(tokens.cachedInput) * BigInt(pricing.cachedInputMicroPerMillion) +
      BigInt(tokens.output) * BigInt(pricing.outputMicroPerMillion) +
      999_999n) /
    1_000_000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('llm_cost_overflow');
  return Number(value);
};
export class HostedLLMError extends Error {
  override readonly name = 'HostedLLMError';
  constructor(
    readonly code:
      | 'unconfigured'
      | 'budget_exhausted'
      | 'quota_exhausted'
      | 'busy'
      | 'usage_unknown'
      | 'operation_closed'
      | 'lease_lost'
      | 'provider_failed',
  ) {
    super(`hosted_llm:${code}`);
  }
}
export interface HostedLLMCostRow {
  readonly tenantId: string;
  readonly confirmedMicro: number;
  readonly reservedMicro: number;
  readonly unknownAttempts: number;
  readonly confirmedAttempts: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}
export interface PlatformLLMRepository {
  execution(input: {
    readonly operationId: string;
    readonly owner: string;
    readonly action: 'acquire' | 'renew' | 'release';
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<boolean>;
  authorized(tenantId: string, generation: number, now: Date): Promise<boolean>;
  reserve(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly generation: number;
    readonly owner: string;
    readonly leaseUntil: Date;
    readonly inputHash: string;
    readonly pricing: HostedLLMPricing;
    readonly budgetMicro: number;
    readonly periodBudgetMicro: number;
    readonly now: Date;
  }): Promise<UsageReservation>;
  find(operationId: string): Promise<UsageReservation | null>;
  attempts(operationId: string): Promise<readonly ProviderAttempt[]>;
  begin(input: {
    readonly owner: string;
    readonly operationId: string;
    readonly id: string;
    readonly requestHash: string;
    readonly reservedCostMicro: number;
    readonly pricing: HostedLLMPricing;
    readonly now: Date;
  }): Promise<ProviderAttempt>;
  complete(input: {
    readonly id: string;
    readonly operationId: string;
    readonly tokens: HostedLLMTokens;
    readonly receiptId: string;
    readonly now: Date;
  }): Promise<ProviderAttempt>;
  settle(input: {
    readonly operationId: string;
    readonly capture: boolean;
    readonly now: Date;
    readonly owner?: string;
    readonly executionStopped?: true;
  }): Promise<UsageReservation>;
  costs(input?: {
    readonly since?: Date;
    readonly until?: Date;
  }): Promise<readonly HostedLLMCostRow[]>;
}
