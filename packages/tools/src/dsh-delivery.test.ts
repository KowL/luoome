import {
  type AgentSessionBinding,
  type AgentSessionBindingRepository,
  assertAgentSessionBindingInvariants,
  type ChatMessage,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { abortDshTurn, beginDshTurn, commitDshTurn, draftReceiptsOf } from './dsh-delivery.js';

const NOW = new Date('2026-10-21T01:00:00.000Z');
const LEASE = 180_000;

class FakeBindingRepository implements AgentSessionBindingRepository {
  binding: AgentSessionBinding | null = null;

  async findByConversation(conversationId: string): Promise<AgentSessionBinding | null> {
    return this.binding?.conversationId === conversationId ? { ...this.binding } : null;
  }

  async list(options?: { readonly accountId?: string }): Promise<readonly AgentSessionBinding[]> {
    if (this.binding === null) return [];
    if (options?.accountId !== undefined && this.binding.accountId !== options.accountId) return [];
    return [{ ...this.binding }];
  }

  async save(binding: AgentSessionBinding): Promise<void> {
    assertAgentSessionBindingInvariants(binding);
    this.binding = { ...binding };
  }

  async claim(binding: AgentSessionBinding): Promise<boolean> {
    assertAgentSessionBindingInvariants(binding);
    if (
      this.binding === null ||
      this.binding.conversationId !== binding.conversationId ||
      (this.binding.pendingRunId !== null && this.binding.pendingRunId !== binding.pendingRunId)
    )
      return false;
    this.binding = { ...binding };
    return true;
  }

  async commit(input: Parameters<AgentSessionBindingRepository['commit']>[0]): Promise<boolean> {
    if (this.binding?.pendingRunId !== input.runId) return false;
    this.binding = {
      ...this.binding,
      dshSessionId: input.dshSessionId,
      profileHash: input.profileHash,
      configHash: input.configHash,
      lastSyncedMessageId: input.lastSyncedMessageId,
      settledDraftReceiptsCursor: input.settledDraftReceiptsCursor,
      status: input.status,
      contextMode: input.contextMode,
      pendingRunId: null,
      pendingAssistantMessageId: null,
      pendingMessageId: null,
      pendingReceiptsCursor: null,
      pendingClaimedAt: null,
      updatedAt: input.updatedAt,
    };
    assertAgentSessionBindingInvariants(this.binding);
    return true;
  }

  async release(input: Parameters<AgentSessionBindingRepository['release']>[0]): Promise<boolean> {
    if (this.binding?.pendingRunId !== input.runId) return false;
    this.binding = {
      ...this.binding,
      status: input.status,
      contextMode: input.contextMode,
      pendingRunId: null,
      pendingAssistantMessageId: null,
      pendingMessageId: null,
      pendingReceiptsCursor: null,
      pendingClaimedAt: null,
      updatedAt: input.updatedAt,
    };
    return true;
  }

  async remove(conversationId: string): Promise<void> {
    if (this.binding?.conversationId === conversationId) this.binding = null;
  }
}

const setup = () => {
  const repository = new FakeBindingRepository();
  const messages = new Map<string, ChatMessage>();
  const repos = {
    agentSessionBinding: repository,
    chat: {
      findMessageById: async (sessionId: string, id: string) => {
        const message = messages.get(id);
        return message !== undefined && message.sessionId === sessionId ? message : null;
      },
    },
  } as unknown as Parameters<typeof beginDshTurn>[0];
  return { repository, messages, repos };
};

const text = (id: string, role: 'user' | 'assistant', body: string) => ({
  id,
  role,
  parts: [{ type: 'text', text: body }],
});

const draft = (id: string, toolCallId: string, body = '草案') => ({
  id,
  role: 'assistant' as const,
  parts: [
    { type: 'text', text: body },
    {
      type: 'tool-create_watchlist',
      toolCallId,
      state: 'output-available',
      output: { __luoomeDraft: true },
    },
  ],
});

const settlement = (
  messageId: string,
  toolCallId: string,
  status: 'succeeded' | 'failed' | 'cancelled',
) => ({
  ...draft(messageId, toolCallId),
  parts: [
    { type: 'text', text: '草案已生成' },
    {
      type: 'tool-create_watchlist',
      toolCallId,
      state: 'output-available',
      output: { draftStatus: status, result: { ok: status === 'succeeded' } },
    },
  ],
});

const begin = (
  repos: Parameters<typeof beginDshTurn>[0],
  input: Partial<Parameters<typeof beginDshTurn>[1]> = {},
) =>
  beginDshTurn(repos, {
    conversationId: 'c1',
    accountId: 'account-1',
    agentDefinitionId: 'general',
    runId: 'run-1',
    assistantMessageId: 'assistant_run-1',
    configHash: 'config-a',
    messages: [],
    now: NOW,
    leaseMs: LEASE,
    ...input,
  });

const commit = (
  repos: Parameters<typeof commitDshTurn>[0],
  lease: {
    runId: string;
    configHash: string;
    profileHash: string | null;
    receiptsCursor: string | null;
  },
  input: Partial<Parameters<typeof commitDshTurn>[1]> = {},
) =>
  commitDshTurn(repos, {
    conversationId: 'c1',
    runId: lease.runId,
    assistantMessageId: `assistant_${lease.runId}`,
    dshSessionId: 'dsn-1',
    observedProfileHash: lease.profileHash ?? 'profile-a',
    expectedProfileHash: lease.profileHash,
    configHash: lease.configHash,
    sessionReusable: true,
    resumed: true,
    receiptsCursor: lease.receiptsCursor,
    now: NOW,
    ...input,
  });

describe('dsh delivery plan', () => {
  it('首次投递重建全部历史，保存成功后下一轮只带增量并复用 session 身份', async () => {
    const { repos, messages } = setup();
    const first = await begin(repos, {
      messages: [text('u1', 'user', '第一个问题')],
    });
    expect(first.kind).toBe('ready');
    if (first.kind !== 'ready') return;
    expect(first.lease.plan).toMatchObject({ mode: 'rebuilt-history', dshSessionId: null });
    expect(first.lease.plan.history).toHaveLength(1);
    expect(first.lease.plan.receipts).toEqual([]);

    messages.set('assistant_run-1', {
      id: 'assistant_run-1',
      sessionId: 'c1',
      role: 'assistant',
      parts: [{ type: 'text', text: '回答' }],
      createdAt: NOW,
    });
    expect(await commit(repos, first.lease)).toBe(true);

    const second = await begin(repos, {
      runId: 'run-2',
      assistantMessageId: 'assistant_run-2',
      messages: [
        text('u1', 'user', '第一个问题'),
        text('assistant_run-1', 'assistant', '回答'),
        text('u2', 'user', '第二个问题'),
      ],
    });
    expect(second.kind).toBe('ready');
    if (second.kind !== 'ready') return;
    expect(second.lease.plan).toMatchObject({
      mode: 'incremental',
      contextMode: 'resumed',
      dshSessionId: 'dsn-1',
    });
    expect(second.lease.plan.history).toEqual([text('u2', 'user', '第二个问题')]);
    expect(await repos.agentSessionBinding.findByConversation('c1')).toMatchObject({
      contextMode: 'resumed',
    });
  });

  it('游标之后新结算的回执恰好投递一次，重启后不再重复', async () => {
    const { repos, messages } = setup();
    const first = await begin(repos, { messages: [text('u1', 'user', '生成草案')] });
    if (first.kind !== 'ready') throw new Error('expected claim');
    messages.set('assistant_run-1', {
      id: 'assistant_run-1',
      sessionId: 'c1',
      role: 'assistant',
      parts: [{ type: 'text', text: '草案' }],
      createdAt: NOW,
    });
    await commit(repos, first.lease);

    // 用户确认后，回执写入上一条 assistant 消息的 parts。
    const confirmed = [
      text('u1', 'user', '生成草案'),
      settlement('assistant_run-1', 'call-1', 'succeeded'),
      text('u2', 'user', '解释确认结果'),
    ];
    const second = await begin(repos, {
      runId: 'run-2',
      assistantMessageId: 'assistant_run-2',
      messages: confirmed,
    });
    if (second.kind !== 'ready') throw new Error('expected claim');
    expect(second.lease.plan.receipts).toEqual([
      expect.objectContaining({ toolCallId: 'call-1', draftStatus: 'succeeded' }),
    ]);
    expect(second.lease.plan.history).toEqual([text('u2', 'user', '解释确认结果')]);
    messages.set('assistant_run-2', {
      id: 'assistant_run-2',
      sessionId: 'c1',
      role: 'assistant',
      parts: [{ type: 'text', text: '解释' }],
      createdAt: NOW,
    });
    await commit(repos, second.lease);

    // 模拟服务重启：同一仓储，新的一轮不应再次注入已送达回执。
    const third = await begin(repos, {
      runId: 'run-3',
      assistantMessageId: 'assistant_run-3',
      messages: [
        ...confirmed,
        text('assistant_run-2', 'assistant', '解释'),
        text('u3', 'user', '继续'),
      ],
    });
    if (third.kind !== 'ready') throw new Error('expected claim');
    expect(third.lease.plan.receipts).toEqual([]);
    expect(third.lease.plan.history).toEqual([text('u3', 'user', '继续')]);
  });

  it('用户文本里的“已确认”不构成回执；重复结算同一 callId 只算一条', () => {
    expect(
      draftReceiptsOf([
        text('u1', 'user', '我已确认，请继续'),
        settlement('assistant_run-1', 'call-1', 'succeeded'),
        settlement('assistant_run-1', 'call-1', 'succeeded'),
      ]),
    ).toEqual([
      {
        messageId: 'assistant_run-1',
        toolCallId: 'call-1',
        tool: 'create_watchlist',
        draftStatus: 'succeeded',
        result: { ok: true },
      },
    ]);
    expect(draftReceiptsOf([settlement('assistant_run-1', 'call-2', 'cancelled')])).toHaveLength(1);
    expect(
      draftReceiptsOf([
        {
          id: 'assistant_run-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-create_watchlist',
              toolCallId: 'call-3',
              state: 'output-available',
              output: { draftStatus: 'executing' },
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it('失败/取消的确认同样作为事实回执投递', async () => {
    const { repos, messages } = setup();
    const first = await begin(repos, { messages: [text('u1', 'user', '生成草案')] });
    if (first.kind !== 'ready') throw new Error('expected claim');
    messages.set('assistant_run-1', {
      id: 'assistant_run-1',
      sessionId: 'c1',
      role: 'assistant',
      parts: [{ type: 'text', text: '草案' }],
      createdAt: NOW,
    });
    await commit(repos, first.lease);
    const second = await begin(repos, {
      runId: 'run-2',
      assistantMessageId: 'assistant_run-2',
      messages: [
        settlement('assistant_run-1', 'call-1', 'failed'),
        text('u2', 'user', '失败了怎么办'),
      ],
    });
    if (second.kind !== 'ready') throw new Error('expected claim');
    expect(second.lease.plan.receipts).toEqual([
      expect.objectContaining({ draftStatus: 'failed', result: { ok: false } }),
    ]);
  });

  it('同会话并发认领返回 busy；租约过期后接管并标记中断重建', async () => {
    const { repos, messages } = setup();
    const first = await begin(repos, { messages: [text('u1', 'user', '第一轮')] });
    expect(first.kind).toBe('ready');
    expect(
      (
        await begin(repos, {
          runId: 'run-2',
          assistantMessageId: 'assistant_run-2',
          messages: [text('u2', 'user', '并发')],
        })
      ).kind,
    ).toBe('busy');

    const expiredNow = new Date(NOW.getTime() + LEASE + 1);
    const takeover = await begin(repos, {
      runId: 'run-3',
      assistantMessageId: 'assistant_run-3',
      messages: [text('u1', 'user', '第一轮'), text('u2', 'user', '接管')],
      now: expiredNow,
    });
    expect(takeover.kind).toBe('ready');
    if (takeover.kind !== 'ready') return;
    expect(takeover.lease.plan.recovered).toBe(true);
    expect(takeover.lease.plan.mode).toBe('rebuilt-history');
    expect(messages.size).toBe(0);
  });

  it('崩溃窗口：答案已落库但游标未更新时判定为已送达，不重复注入', async () => {
    const { repos, messages } = setup();
    const first = await begin(repos, { messages: [text('u1', 'user', '第一轮')] });
    if (first.kind !== 'ready') throw new Error('expected claim');
    // 模拟：assistant 消息已保存，但进程在推进游标前退出（pending 仍指向该轮）。
    messages.set('assistant_run-1', {
      id: 'assistant_run-1',
      sessionId: 'c1',
      role: 'assistant',
      parts: [{ type: 'text', text: '回答' }],
      createdAt: NOW,
    });
    const next = await begin(repos, {
      runId: 'run-2',
      assistantMessageId: 'assistant_run-2',
      messages: [
        text('u1', 'user', '第一轮'),
        text('assistant_run-1', 'assistant', '回答'),
        text('u2', 'user', '第二轮'),
      ],
      now: new Date(NOW.getTime() + 1000),
    });
    if (next.kind !== 'ready') throw new Error('expected claim');
    // 被吞掉的那一轮没有 session 记录，所以本轮仍按可信历史重建，但游标已补齐。
    expect(next.lease.plan.recovered).toBe(false);
    expect(next.lease.plan.history).toHaveLength(3);
    expect(next.lease.plan.dshSessionId).toBeNull();
  });

  it('profile/config 变化使绑定失效并重建，新轮次不再复用 dshSessionId', async () => {
    const { repos, messages } = setup();
    const first = await begin(repos, { messages: [text('u1', 'user', '第一轮')] });
    if (first.kind !== 'ready') throw new Error('expected claim');
    messages.set('assistant_run-1', {
      id: 'assistant_run-1',
      sessionId: 'c1',
      role: 'assistant',
      parts: [{ type: 'text', text: '回答' }],
      createdAt: NOW,
    });
    await commit(repos, first.lease);

    const changed = await begin(repos, {
      runId: 'run-2',
      assistantMessageId: 'assistant_run-2',
      configHash: 'config-b',
      messages: [
        text('u1', 'user', '第一轮'),
        text('assistant_run-1', 'assistant', '回答'),
        text('u2', 'user', '第二轮'),
      ],
    });
    if (changed.kind !== 'ready') throw new Error('expected claim');
    expect(changed.lease.plan).toMatchObject({
      mode: 'rebuilt-history',
      dshSessionId: null,
      recovered: true,
    });
    expect(changed.lease.plan.history).toHaveLength(3);

    messages.set('assistant_run-2', {
      id: 'assistant_run-2',
      sessionId: 'c1',
      role: 'assistant',
      parts: [{ type: 'text', text: '回答二' }],
      createdAt: NOW,
    });
    await commit(repos, changed.lease, { dshSessionId: 'dsn-2' });
    await expect(repos.agentSessionBinding.findByConversation('c1')).resolves.toMatchObject({
      dshSessionId: 'dsn-2',
      status: 'active',
      configHash: 'config-b',
    });
  });

  it('观察到的 profileHash 变化会提交为 invalidated 并丢弃会话', async () => {
    const { repos, messages } = setup();
    const first = await begin(repos, { messages: [text('u1', 'user', '第一轮')] });
    if (first.kind !== 'ready') throw new Error('expected claim');
    messages.set('assistant_run-1', {
      id: 'assistant_run-1',
      sessionId: 'c1',
      role: 'assistant',
      parts: [{ type: 'text', text: '回答' }],
      createdAt: NOW,
    });
    await commit(repos, first.lease, { observedProfileHash: 'profile-a' });
    const second = await begin(repos, {
      runId: 'run-2',
      assistantMessageId: 'assistant_run-2',
      messages: [
        text('u1', 'user', '第一轮'),
        text('assistant_run-1', 'assistant', '回答'),
        text('u2', 'user', '第二轮'),
      ],
    });
    if (second.kind !== 'ready') throw new Error('expected claim');
    expect(second.lease.plan.dshSessionId).toBe('dsn-1');
    messages.set('assistant_run-2', {
      id: 'assistant_run-2',
      sessionId: 'c1',
      role: 'assistant',
      parts: [{ type: 'text', text: '回答二' }],
      createdAt: NOW,
    });
    expect(await commit(repos, second.lease, { observedProfileHash: 'profile-b' })).toBe(true);
    expect(await repos.agentSessionBinding.findByConversation('c1')).toMatchObject({
      status: 'invalidated',
      dshSessionId: null,
      profileHash: 'profile-b',
    });
  });

  it('abort 释放认领并标记 interrupted，下一轮可继续', async () => {
    const { repos } = setup();
    const first = await begin(repos, { messages: [text('u1', 'user', '第一轮')] });
    if (first.kind !== 'ready') throw new Error('expected claim');
    expect(await abortDshTurn(repos, { conversationId: 'c1', runId: 'run-1', now: NOW })).toBe(
      true,
    );
    expect(await repos.agentSessionBinding.findByConversation('c1')).toMatchObject({
      status: 'interrupted',
      pendingRunId: null,
    });
    expect(
      (
        await begin(repos, {
          runId: 'run-2',
          assistantMessageId: 'assistant_run-2',
          messages: [text('u1', 'user', '第一轮'), text('u2', 'user', '第二轮')],
        })
      ).kind,
    ).toBe('ready');
  });

  it('绑定属于其它账户时拒绝', async () => {
    const { repos } = setup();
    await begin(repos, { messages: [] });
    expect(await begin(repos, { accountId: 'account-2', runId: 'run-2' })).toMatchObject({
      kind: 'conflict',
    });
  });
});
