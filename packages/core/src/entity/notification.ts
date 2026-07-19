import { z } from 'zod';

/**
 * 通知（v0.3 起，ARCHITECTURE §5.1 扩字段 + plan-v0.2-v0.3 §2.5）。
 *
 * 设计要点：
 * - v0.3 只支持 feishu + log 两个 channel；email / wecom / slack 留 v0.4+。
 * - Notification 走持久化（notification 表）：审计 + 重试 + 失败排查。
 * - payload 是 discriminated union（按 channel 走不同 schema），但都含 title / content。
 *
 * 副作用等级：external（HTTP 调用第三方）。MCP 默认 opt-in 暴露。
 */

export type NotificationChannel = 'feishu' | 'log';

export const NotificationChannelSchema = z.enum(['feishu', 'log']);

export type NotificationLevel = 'info' | 'warn' | 'error' | 'success';

export const NotificationLevelSchema = z.enum(['info', 'warn', 'error', 'success']);

/** feishu payload：title + markdown content + 可选 atMobiles（@手机号）。 */
export const FeishuPayloadSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(5000),
  level: NotificationLevelSchema.default('info'),
  /** @ 的手机号列表（飞书卡片支持）；缺省不 @。 */
  atMobiles: z.array(z.string()).optional(),
});

/** log payload：title + content + level，logger.info / warn / error 自动按 level 路由。 */
export const LogPayloadSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(5000),
  level: NotificationLevelSchema.default('info'),
});

/** 联合 payload schema（按 channel 走对应 schema）。 */
export const NotificationPayloadSchema = z.union([FeishuPayloadSchema, LogPayloadSchema]);

export type FeishuPayload = z.infer<typeof FeishuPayloadSchema>;
export type LogPayload = z.infer<typeof LogPayloadSchema>;
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

/** 发送结果（落库时用）。 */
export type NotificationResult = 'success' | 'failed' | 'suppressed';

export const NotificationResultSchema = z.enum(['success', 'failed', 'suppressed']);

/**
 * Notification 实体（v0.3 起；notification 表的 row）。
 * 关联字段（adviceId / tacticSignalId）是软关联（不强 FK），允许 null。
 */
export interface Notification {
  readonly id: string;
  readonly channel: NotificationChannel;
  readonly payload: NotificationPayload;
  readonly result: NotificationResult;
  /** 失败原因（result=failed 时必填）。 */
  readonly errorMessage?: string;
  /** 软关联：被通知的 Advice id（高信心度建议推送场景）。 */
  readonly adviceId?: string;
  /** 软关联：被通知的 TacticSignal id（战法信号推送场景）。 */
  readonly tacticSignalId?: string;
  readonly sentAt: Date;
}

export const NotificationSchema = z.object({
  id: z.string().min(1),
  channel: NotificationChannelSchema,
  payload: NotificationPayloadSchema,
  result: NotificationResultSchema,
  errorMessage: z.string().optional(),
  adviceId: z.string().optional(),
  tacticSignalId: z.string().optional(),
  sentAt: z.coerce.date(),
});

// ---------- 不变量 ----------

export const assertNotificationInvariants = (n: Notification): void => {
  if (n.result === 'failed' && (n.errorMessage === undefined || n.errorMessage === '')) {
    throw new Error('result=failed 时 errorMessage 必填');
  }
  // payload 与 channel 必须匹配：feishu 走 feishu schema（@mobiles 可选），log 走 log schema
  // （zod union parse 已保证，这里再做运行时兜底）
  if (n.channel === 'feishu' && 'atMobiles' in n.payload && n.payload.atMobiles !== undefined) {
    for (const m of n.payload.atMobiles) {
      if (!/^1\d{10}$/.test(m)) {
        throw new Error(`atMobiles 必须是 11 位手机号: ${m}`);
      }
    }
  }
};

// ---------- 默认配置常量 ----------

/** LUOOME_FEISHU_WEBHOOK_URL 未配置时降级为 log channel。 */
export const DEFAULT_NOTIFICATION_CHANNEL: NotificationChannel = 'log';

/** 飞书卡片标题前缀（与 app 关联，方便用户在飞书群里辨认来源）。 */
export const NOTIFICATION_BRAND = 'luoome';
