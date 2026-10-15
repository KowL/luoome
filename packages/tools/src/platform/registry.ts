import { platformAdminTools } from './admin.js';
import { platformAuthTools } from './auth.js';
import type { PlatformTool } from './define-platform-tool.js';
import { platformJobTools } from './jobs.js';
import { platformLLMTools } from './llm.js';
import { platformNotificationTools } from './notifications.js';
import { platformPaymentTools } from './payments.js';
import { platformPrivacyTools } from './privacy.js';
import { workerRuntimeTools } from './worker-runtime.js';

export const createPlatformRegistry = (tools: readonly PlatformTool[]) => {
  const byName = new Map<string, PlatformTool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Duplicate platform tool name: ${tool.name}`);
    byName.set(tool.name, tool);
  }
  return Object.freeze({
    all: (): readonly PlatformTool[] => Object.freeze([...byName.values()]),
    get: (name: string): PlatformTool | undefined => byName.get(name),
  });
};

export const platformToolRegistry = createPlatformRegistry([
  ...platformLLMTools,
  ...platformAdminTools,
  ...platformAuthTools,
  ...platformJobTools,
  ...platformNotificationTools,
  ...workerRuntimeTools,
  ...platformPaymentTools,
  ...platformPrivacyTools,
]);
