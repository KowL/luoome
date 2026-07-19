import {
  type FeishuPayload,
  type LogPayload,
  NOTIFICATION_BRAND,
  type Notification,
  type NotificationChannel,
  type NotificationPayload,
  type NotificationResult,
  type RepositoryRegistry,
} from '@luoome/core';

import { FeishuAdapterError, type FeishuWebhookAdapter } from './feishu.js';
import { LogChannelAdapter } from './log-channel.js';
import type { NotificationSendOutcome } from './types.js';

/**
 * NotificationManager（plan-v0.2-v0.3 §2.5）。
 *
 * 职责：
 * 1. 按 channel 路由到对应适配器；
 * 2. 写库：无论成功 / 失败 / suppressed 都落库（审计 + 复盘）；
 * 3. 失败时不抛（manager 内部 catch），永远返回 Notification，便于上层工具
 *    直接转成 ToolResult 而不是异常路径。
 *
 * 路由规则：
 *   - channel=feishu 且 feishu adapter 未配置（缺 URL）→ 降级为 log channel + result='suppressed'
 *   - channel=log → log adapter
 */

export interface NotificationManagerOptions {
  readonly repos: RepositoryRegistry;
  readonly feishu?: FeishuWebhookAdapter | undefined;
  readonly logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
  /** 通知 ID 生成器（测试可注入）；默认 `notif-<ts>-<rand>`。 */
  readonly idGenerator?: () => string;
  /** 时钟注入；默认 Date.now。 */
  readonly clock?: () => Date;
}

const defaultIdGen = (): string =>
  `notif-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

export class NotificationManager {
  private readonly feishu: FeishuWebhookAdapter | undefined;
  private readonly log: LogChannelAdapter;
  private readonly repos: RepositoryRegistry;
  private readonly idGen: () => string;
  private readonly clock: () => Date;
  private readonly logger: NotificationManagerOptions['logger'];

  constructor(options: NotificationManagerOptions) {
    this.repos = options.repos;
    this.feishu = options.feishu;
    this.logger = options.logger;
    this.idGen = options.idGenerator ?? defaultIdGen;
    this.clock = options.clock ?? (() => new Date());
    this.log = new LogChannelAdapter({ logger: options.logger });
  }

  /**
   * 发送通知并落库。payload 必须与 channel 匹配（feishu 走 feishu schema，log 走 log schema）。
   * 调用方负责把 channel + payload 准备好；本函数不重试、不抛。
   */
  async send(input: {
    readonly channel: NotificationChannel;
    readonly payload: NotificationPayload;
    readonly adviceId?: string;
    readonly tacticSignalId?: string;
  }): Promise<NotificationSendOutcome> {
    const id = this.idGen();
    const sentAt = this.clock();
    const base = {
      id,
      channel: input.channel,
      payload: input.payload,
      sentAt,
      ...(input.adviceId !== undefined ? { adviceId: input.adviceId } : {}),
      ...(input.tacticSignalId !== undefined ? { tacticSignalId: input.tacticSignalId } : {}),
    };

    let result: NotificationResult;
    let errorMessage: string | undefined;

    try {
      if (input.channel === 'feishu') {
        if (this.feishu === undefined) {
          result = 'suppressed';
          this.logger.warn('[notify] feishu 未配置，降级为 suppressed', { id });
        } else {
          await this.feishu.send(input.payload as FeishuPayload);
          result = 'success';
        }
      } else {
        await this.log.send(input.payload as LogPayload);
        result = 'success';
      }
    } catch (e) {
      result = 'failed';
      if (e instanceof FeishuAdapterError) {
        errorMessage = `[${e.statusCode ?? 'no-status'}/${e.recoverable ? 'recoverable' : 'fatal'}] ${e.message}`;
      } else {
        errorMessage = e instanceof Error ? e.message : String(e);
      }
      this.logger.error('[notify] send failed', { id, errorMessage });
    }

    const notification: Notification = {
      ...base,
      result,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
    await this.repos.notification.save(notification);
    return { notification };
  }

  /**
   * 强制走 log channel（不论入参 channel），用于 feishu 未配置时的 fallback。
   * 落库时 result=success（log 永远成功），但保留原始 channel=log 标识。
   */
  async sendLog(input: {
    readonly title: string;
    readonly content: string;
    readonly level?: LogPayload['level'];
    readonly adviceId?: string;
    readonly tacticSignalId?: string;
  }): Promise<NotificationSendOutcome> {
    const level = input.level ?? 'info';
    return this.send({
      channel: 'log',
      payload: { title: input.title, content: input.content, level },
      ...(input.adviceId !== undefined ? { adviceId: input.adviceId } : {}),
      ...(input.tacticSignalId !== undefined ? { tacticSignalId: input.tacticSignalId } : {}),
    });
  }

  /** 便捷：brand 前缀自动加（仅 log 通道）。 */
  async info(input: {
    readonly title: string;
    readonly content: string;
    readonly adviceId?: string;
    readonly tacticSignalId?: string;
  }): Promise<NotificationSendOutcome> {
    return this.sendLog({ ...input, level: 'info' });
  }
}

export { FeishuAdapterError, FeishuWebhookAdapter } from './feishu.js';
export { LogChannelAdapter } from './log-channel.js';
export type { NotificationChannelAdapter } from './types.js';
export { NOTIFICATION_BRAND };
