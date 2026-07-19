import type {
  FeishuPayload,
  LogPayload,
  Notification,
  NotificationChannel,
  NotificationPayload,
} from '@luoome/core';

/**
 * 通知通道适配器（plan-v0.2-v0.3 §2.5）。
 * 不同 channel 走不同 schema（feishu / log），通过 discriminated union 分发。
 * 实现类只需关心自己 channel 的 payload 子集。
 */

export interface NotificationChannelAdapter<P extends NotificationPayload = NotificationPayload> {
  readonly name: string;
  readonly channel: NotificationChannel;
  send(
    payload: P,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly errorMessage: string }>;
}

/** Feishu 通道专用（强类型）。 */
export type FeishuChannelAdapter = NotificationChannelAdapter<FeishuPayload>;
/** Log 通道专用。 */
export type LogChannelAdapterType = NotificationChannelAdapter<LogPayload>;

/** Manager 输出的发送结果（写库用）。 */
export interface NotificationSendOutcome {
  readonly notification: Notification;
}
