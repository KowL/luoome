import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule';
import type { PluginAuthorityRepository, ToolContext } from '@luoome/core';
import {
  type ConfirmablePluginTool,
  type PluginPrincipal,
  pluginInputHash,
  pluginInputJson,
} from '@luoome/tools';
import { dshScheduleHash } from './dsh-identity.js';

export const AUTOMATION_CATALOG_TOOL = 'luoome_automation_catalog';

export const createAutomationCatalog =
  (options: {
    readonly profile: string;
    readonly policyVersion: number;
    readonly repository: PluginAuthorityRepository;
    readonly policies: readonly ConfirmablePluginTool[];
    readonly context: () => ToolContext | Promise<ToolContext>;
    readonly principalForSession: (sessionId: string) => PluginPrincipal | null;
    readonly tasks: () => Promise<readonly ScheduleCatalogEntry[]>;
  }) =>
  async (principal: PluginPrincipal) => {
    const ctx = await options.context();
    const allowedCalls = await Promise.all(
      options.policies
        .filter((policy) => policy.scheduled)
        .map(async (policy) => {
          const input = await policy.bind({}, principal, 'grant-preview', ctx);
          return {
            tool: policy.tool.name,
            accountId: principal.accountId,
            inputJson: pluginInputJson(input),
            inputHash: pluginInputHash(input),
            capabilities: policy.tool.requiredCapabilities,
          };
        }),
    );
    const tasks = (await options.tasks()).filter((task) => {
      const owner = options.principalForSession(task.sessionId);
      return owner?.userId === principal.userId && owner.accountId === principal.accountId;
    });
    return {
      asOf: ctx.clock().getTime(),
      policyVersion: options.policyVersion,
      allowedCalls,
      total: tasks.length,
      tasks: await Promise.all(
        tasks.slice(0, 100).map(async (task) => {
          const grantId = `batch:${task.id}:${principal.accountId}`;
          return {
            task,
            identity: {
              profile: options.profile,
              userId: principal.userId,
              sessionId: task.sessionId,
              taskId: task.id,
            },
            scheduleHash: dshScheduleHash(task),
            grantId,
            existingGrant: await options.repository.findGrant(grantId, principal.userId),
          };
        }),
      ),
    };
  };
