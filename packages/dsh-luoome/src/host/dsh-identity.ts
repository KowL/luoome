import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import { ScheduleId, type ScheduleRecord } from '@deepseek-ai/dsh-schedule';
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { PluginAuthorityRepository, PluginAutomationGrant } from '@luoome/core';
import { type PluginPrincipal, pluginInputHash } from '@luoome/tools';
import type { ScheduledOperationRequest } from './operations.js';

// The pinned SDK emits this source, but its public schedule barrel omits runtime.d.ts.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    schedule: { kind: 'schedule' } & ContextFormed;
  }
}

export const dshScheduleHash = (record: ScheduleRecord): string => {
  const base = { id: record.id, kind: record.kind, title: record.title, prompt: record.prompt };
  switch (record.kind) {
    case 'after':
      return pluginInputHash({
        ...base,
        afterSeconds: record.afterSeconds,
        scheduledAt: record.scheduledAt,
      });
    case 'at':
      return pluginInputHash({ ...base, scheduledAt: record.scheduledAt });
    case 'every':
      return pluginInputHash({ ...base, everySeconds: record.everySeconds });
    case 'daily':
      return pluginInputHash({ ...base, time: record.time, timeZone: record.timeZone });
    case 'weekly':
      return pluginInputHash({
        ...base,
        time: record.time,
        timeZone: record.timeZone,
        weekdays: record.weekdays,
      });
    case 'cron':
      return pluginInputHash({ ...base, expression: record.expression, timeZone: record.timeZone });
  }
};

const scheduledTurn = (agent: Agent) => {
  const messages = new Set<string>();
  for (let i = agent.session.seq - 1; i >= agent.session.inheritedEventCount; i--) {
    const event = agent.session.eventAt(SessionSeq(i));
    if (event?.type === 'turn/end') return null;
    if (event?.type === 'turn/start')
      return messages.size > 0 ? { start: event.seq, messages } : null;
    if (event?.type === 'user/message') {
      if (event.data.source.kind !== 'schedule') return null;
      messages.add(event.data.id);
    }
  }
  return null;
};

export const createDshIdentity = (
  ctx: Context,
  options: {
    readonly profile: string;
    readonly repository: PluginAuthorityRepository;
    readonly principalForSession: (sessionId: string) => PluginPrincipal | null;
    readonly now: () => number;
  },
) => {
  const principal = (agent: Agent | undefined) => {
    if (
      !agent ||
      ctx.agents.get(agent.id) !== agent ||
      agent.id !== agent.session.id ||
      delegationDepthOf(agent) !== 0
    )
      return null;
    return options.principalForSession(agent.id);
  };
  const taskForGrant = async (grant: PluginAutomationGrant) => {
    const owner = options.principalForSession(grant.identity.sessionId);
    if (
      !owner ||
      owner.userId !== grant.identity.userId ||
      grant.identity.profile !== options.profile ||
      grant.allowedCalls.some((c) => c.accountId !== owner.accountId)
    )
      return null;
    const task = (await ctx.schedule.catalog()).find(
      (t) => t.id === grant.identity.taskId && t.sessionId === grant.identity.sessionId,
    );
    if (!task) return null;
    return dshScheduleHash(task) === grant.scheduleHash ? task : null;
  };
  return {
    principal,
    validateGrant: async (grant: PluginAutomationGrant) => (await taskForGrant(grant)) !== null,
    async scheduled(execution: ToolExecution, request: ScheduledOperationRequest) {
      const owner = principal(execution.agent);
      if (!owner || request.accountId !== owner.accountId || !execution.agent) return null;
      const agent = execution.agent;
      const turn = scheduledTurn(agent);
      if (!turn) return null;
      const grant = await options.repository.findGrant(request.grantId, owner.userId);
      if (
        !grant?.enabled ||
        grant.version !== request.grantVersion ||
        grant.identity.sessionId !== agent.session.id
      )
        return null;

      // DSH wakes the Agent before persisting the delivery receipt. Wait only for that acknowledgment.
      return new Promise<{
        identity: PluginAutomationGrant['identity'];
        occurrenceId: string;
      } | null>((resolve) => {
        let finished = false;
        let checking = false;
        let dirty = false;
        const finish = (
          value: { identity: PluginAutomationGrant['identity']; occurrenceId: string } | null,
        ) => {
          if (finished) return;
          finished = true;
          remove();
          clearTimeout(timer);
          execution.signal.removeEventListener('abort', abort);
          resolve(value);
        };
        const abort = () => finish(null);
        const check = async () => {
          if (finished) return;
          if (checking) {
            dirty = true;
            return;
          }
          checking = true;
          try {
            if (
              execution.signal.aborted ||
              !principal(agent) ||
              scheduledTurn(agent)?.start !== turn.start ||
              !(await taskForGrant(grant))
            )
              return finish(null);
            const page = await ctx.schedule.history({
              sessionId: SessionId(agent.id),
              id: ScheduleId(grant.identity.taskId),
              limit: 100,
            });
            if ('code' in page) return finish(null);
            const now = options.now();
            const matches = page.records.filter(
              (r) =>
                turn.messages.has(r.messageId) &&
                Date.parse(r.scheduledAt) >= grant.createdAt &&
                Date.parse(r.scheduledAt) < grant.expiresAt &&
                Date.parse(r.scheduledAt) <= Date.parse(r.deliveredAt) &&
                Date.parse(r.deliveredAt) <= now &&
                now - Date.parse(r.deliveredAt) <= 600_000,
            );
            if (matches.length > 1) return finish(null);
            const [matched] = matches;
            if (matched) {
              if (scheduledTurn(agent)?.start !== turn.start || execution.signal.aborted)
                return finish(null);
              return finish({ identity: grant.identity, occurrenceId: matched.scheduledAt });
            }
          } catch {
            finish(null);
          } finally {
            checking = false;
            if (dirty && !finished) {
              dirty = false;
              void check();
            }
          }
        };
        const remove = ctx.on('schedule/changed', () => {
          void check();
        });
        const timer = setTimeout(() => finish(null), 2000);
        execution.signal.addEventListener('abort', abort, { once: true });
        void check();
      });
    },
  };
};
