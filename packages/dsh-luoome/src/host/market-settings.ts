import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  FUYAO_DEFAULT_BASE_URL,
  MARKET_SOURCE_MANIFEST,
  type MarketSourceId,
  MarketSourceOrderSchema,
  marketSourceOrderFromEnv,
} from '@luoome/adapters';
import { parseEnvFile } from '@luoome/core';
import { z } from 'zod';
import { invalidInput } from './read-surface.js';
import { readPluginJson } from './routes.js';

const BaseUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/[\r\n\0]/.test(value)
    );
  }, '请输入不含凭据、查询参数或片段的 HTTP(S) 服务地址');

/** 设置页可收集凭据的源（**从 manifest 的 `requiredEnv` 派生**，不硬编码）。 */
export const CREDENTIAL_SOURCES = (Object.keys(MARKET_SOURCE_MANIFEST) as MarketSourceId[]).filter(
  (id) => MARKET_SOURCE_MANIFEST[id].requiredEnv !== undefined,
);

/**
 * 凭据分区（M3-15）：每个需要 `requiredEnv` 的源一格。
 *
 * 三态契约（task-25 同族）：
 * - **缺席** = 保留现有密钥；`''` = 保留（等同缺席）
 * - **非空** = 更新
 * - **`clear: true`** = **显式清空**（唯一的删除入口；`''` 绝不等于清空）
 */
const CredentialSectionSchema = z
  .object({
    baseUrl: BaseUrl.optional(),
    apiKey: z
      .string()
      .trim()
      .max(4096)
      .regex(/^[^\r\n\0]*$/)
      .optional(),
    clear: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) => !(value.clear && value.apiKey !== undefined && value.apiKey.trim().length > 0),
    'clear 与 apiKey 不能同时给出',
  );

const FeishuWebhookUrlSchema = z
  .url('Webhook 必须是合法 URL')
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'open.feishu.cn' &&
      /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(url.pathname) &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  }, '仅支持飞书自定义机器人的 HTTPS Webhook（https://open.feishu.cn/open-apis/bot/v2/hook/…）');

/**
 * 飞书通知通道的三态（与行情源凭据**同语义**，但密钥形态不同）：
 * - **缺席** = 保留现有 Webhook；`''` = 保留（等同缺席）
 * - **非空** = 更新（必须通过 `FeishuWebhookUrlSchema` 白名单）
 * - **`clearWebhook: true`** = **显式清空**（唯一的删除入口）
 */
const FeishuChannelSchema = z
  .object({
    webhookUrl: z
      .string()
      .trim()
      .max(2_048)
      .refine((value) => !/[\r\n\0]/.test(value), 'Webhook 必须是单行文本')
      .optional(),
    clearWebhook: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) =>
      !(value.clearWebhook && value.webhookUrl !== undefined && value.webhookUrl.trim().length > 0),
    'clearWebhook 与 webhookUrl 不能同时给出',
  );

export const SaveMarketSettingsSchema = z
  .object({
    sources: MarketSourceOrderSchema,
    fuyao: CredentialSectionSchema,
    /** 其它需要凭据的源；键 = 源 id。 */
    credentials: z.record(z.string(), CredentialSectionSchema).optional().default({}),
    /** 非行情源通道（task-32）：飞书通知。与 `credentials` 并列，不混进 manifest。 */
    notifications: z.object({ feishu: FeishuChannelSchema.optional() }).strict().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [id, section] of Object.entries(value.credentials)) {
      const entry = MARKET_SOURCE_MANIFEST[id as MarketSourceId];
      if (entry === undefined || entry.requiredEnv === undefined) {
        ctx.addIssue({ code: 'custom', path: ['credentials', id], message: `未知的凭据源：${id}` });
        continue;
      }
      if (section.baseUrl !== undefined && (entry.settingsFields ?? []).length === 0)
        ctx.addIssue({
          code: 'custom',
          path: ['credentials', id],
          message: `${id} 不接受服务地址`,
        });
    }
  });

export type SaveMarketSettings = z.infer<typeof SaveMarketSettingsSchema>;

const SOURCE_LABELS: Readonly<Record<MarketSourceId, string>> = {
  eastmoney: '东方财富',
  tencent: '腾讯行情',
  sina: '新浪行情',
  xueqiu: '雪球（沪深报价 / 日线）',
  fuyao: 'FUYAO（同花顺）',
};
/** 收到的一个「非行情源」凭据通道（task-32：飞书通知）。语义与行情源不同，见 `kind`。 */
export const NOTIFICATION_CREDENTIAL_ID = 'feishu' as const;
export const FEISHU_SECRET_KEY = 'LUOOME_FEISHU_WEBHOOK_URL' as const;

const FEISHU_WEBHOOK_LABEL = '飞书通知（自定义机器人 Webhook）';

/**
 * 构造期允许从磁盘 `.env` 覆盖的键。
 *
 * task-32：`LUOOME_FEISHU_WEBHOOK_URL` 必须在这里——否则重启后磁盘上的 Webhook
 * 不会被读进 `this.env`，设置页显示「未配置」而实际发送链路也读不到。
 * **仍然只放这些键**：本地配置不能改 owner、工具授权或交易开关。
 */
const SETTINGS_KEYS = [
  'LUOOME_MARKET_SOURCES',
  'FUYAO_BASE_URL',
  'FUYAO_API_KEY',
  FEISHU_SECRET_KEY,
  // task-38：研究库**界面已废弃**，但这几个键**必须留在白名单里**——
  // 移出白名单意味着磁盘上用户手写的值读不进运行时，等于「废弃界面顺带废掉已有配置」。
  // 这是 task-32 那个坑（键不加进白名单 → 重启后读不到）的同一机制的两面。
  'LUOOME_RESEARCH_VAULT',
  'LUOOME_RESEARCH_VAULT_ID',
  'LUOOME_RESEARCH_ROOT',
  'LUOOME_RESEARCH_MANAGED_ROOT',
  'LUOOME_RESEARCH_MAX_TEXT_MB',
  'LUOOME_RESEARCH_MAX_ATTACHMENT_MB',
] as const;

export interface MarketSettingsView {
  readonly activeOrder: readonly MarketSourceId[];
  readonly sources: readonly {
    readonly id: MarketSourceId;
    readonly label: string;
    readonly configured: boolean;
  }[];
  readonly fuyao: { readonly baseUrl: string; readonly configured: boolean };
  /**
   * 设置页凭据分区（M3-15）：从 manifest 的 `requiredEnv` 派生，**只有 `configured` 布尔，永不回显密钥**。
   *
   * task-32：数组里**追加非行情源的通道**（飞书通知）。判别字段 `kind` 让消费方不必按 id 特判：
   * - `market-source`：行情源凭据（从 `MARKET_SOURCE_MANIFEST` 派生）
   * - `notification-channel`：通知通道（如飞书 Webhook）
   */
  readonly credentials: readonly (
    | {
        readonly kind: 'market-source';
        readonly id: MarketSourceId;
        readonly label: string;
        readonly envKey: string;
        readonly configured: boolean;
        readonly baseUrl?: string;
      }
    | {
        readonly kind: 'notification-channel';
        readonly id: typeof NOTIFICATION_CREDENTIAL_ID;
        readonly label: string;
        readonly envKey: typeof FEISHU_SECRET_KEY;
        readonly configured: boolean;
        /** 飞书 webhook 的**端点域名**（固定值，不回显完整 URL）。 */
        readonly endpoint: 'open.feishu.cn';
      }
  )[];
}

export interface MarketSettings {
  read(): MarketSettingsView;
  save(input: SaveMarketSettings): MarketSettingsView;
}

export class MarketSettingsStore {
  private env: Record<string, string | undefined>;

  constructor(
    baseEnv: Readonly<Record<string, string | undefined>>,
    private readonly path: string,
  ) {
    const saved = parseEnvFile(this.readFile());
    this.env = { ...baseEnv };
    // 本地行情配置只能覆盖这三个键，不能改变 owner、工具授权或交易开关。
    for (const key of SETTINGS_KEYS) {
      if (saved[key] !== undefined) this.env[key] = saved[key];
    }
  }

  private readFile(): string {
    return existsSync(this.path) ? readFileSync(this.path, 'utf8') : '';
  }

  /**
   * 运行时候选 = 磁盘上的**全部**键（不只 `SETTINGS_KEYS`）。
   *
   * 修复（REQ-M3-15 §3）：原实现把 `changes` 合并到内存 `this.env` 上，
   * 于是「磁盘上不在 `SETTINGS_KEYS` 里的键」（人工写入、或将来新增的凭据键）
   * 在保存之后运行时不生效——设置页显示已配置、运行时却读不到。
   */
  private candidateFromDisk(
    overrides: Readonly<Record<string, string>>,
    removals: ReadonlySet<string>,
  ): Record<string, string | undefined> {
    const candidate: Record<string, string | undefined> = { ...this.env, ...overrides };
    for (const key of removals) delete candidate[key];
    return candidate;
  }

  runtimeEnv(): Record<string, string | undefined> {
    return { ...this.env };
  }

  read(): MarketSettingsView {
    const sources = (Object.keys(SOURCE_LABELS) as MarketSourceId[]).map((id) => {
      const required = MARKET_SOURCE_MANIFEST[id].requiredEnv;
      return {
        id,
        label: SOURCE_LABELS[id],
        configured: required === undefined || Boolean(this.env[required.key]?.trim()),
      };
    });
    return {
      activeOrder: marketSourceOrderFromEnv(this.env),
      sources,
      fuyao: {
        baseUrl: this.env.FUYAO_BASE_URL?.trim() || FUYAO_DEFAULT_BASE_URL,
        configured: Boolean(this.env.FUYAO_API_KEY?.trim()),
      },
      // 设置页凭据分区：一格一个源，全部从 manifest 的 requiredEnv 派生（不硬编码）。
      credentials: [
        ...CREDENTIAL_SOURCES.map((id) => {
          const entry = MARKET_SOURCE_MANIFEST[id];
          const key = entry.requiredEnv?.key ?? '';
          return {
            kind: 'market-source' as const,
            id,
            label: SOURCE_LABELS[id],
            envKey: key,
            configured: Boolean(this.env[key]?.trim()),
            ...((entry.settingsFields ?? []).length === 0
              ? {}
              : {
                  baseUrl:
                    this.env[`${id.toUpperCase()}_BASE_URL`]?.trim() ||
                    entry.settingsFields?.[0]?.defaultValue ||
                    '',
                }),
          };
        }),
        // 非行情源的通道：**不是** manifest 里的源，用 `kind` 区分，消费方无需按 id 特判。
        {
          kind: 'notification-channel' as const,
          id: NOTIFICATION_CREDENTIAL_ID,
          label: FEISHU_WEBHOOK_LABEL,
          envKey: FEISHU_SECRET_KEY,
          configured: Boolean(this.env[FEISHU_SECRET_KEY]?.trim()),
          endpoint: 'open.feishu.cn' as const,
        },
      ],
    };
  }

  save(
    input: SaveMarketSettings,
    prepareApply: (env: Record<string, string | undefined>) => () => void,
  ): MarketSettingsView {
    const removals = new Set<string>();
    const changes: Record<string, string> = { LUOOME_MARKET_SOURCES: input.sources.join(',') };
    if (input.fuyao.baseUrl !== undefined)
      changes.FUYAO_BASE_URL = input.fuyao.baseUrl.replace(/\/+$/, '');
    // 空串与缺席同义：都表示「保留现有密钥」。
    if (input.fuyao.apiKey !== undefined && input.fuyao.apiKey.trim().length > 0)
      changes.FUYAO_API_KEY = input.fuyao.apiKey;
    if (input.fuyao.clear) removals.add('FUYAO_API_KEY');
    for (const [id, section] of Object.entries(input.credentials)) {
      const entry = MARKET_SOURCE_MANIFEST[id as MarketSourceId];
      const key = entry.requiredEnv?.key;
      if (key === undefined) continue;
      if (section.apiKey !== undefined && section.apiKey.trim().length > 0)
        changes[key] = section.apiKey;
      if (section.clear) removals.add(key);
      if (section.baseUrl !== undefined) changes[`${id.toUpperCase()}_BASE_URL`] = section.baseUrl;
    }
    // 飞书通知通道（task-32）：与凭据**同三态**——空串/缺席保留，`clearWebhook` 才删除。
    const feishu = input.notifications?.feishu;
    if (feishu !== undefined) {
      if (feishu.clearWebhook) removals.add(FEISHU_SECRET_KEY);
      else if (feishu.webhookUrl !== undefined && feishu.webhookUrl.trim().length > 0)
        changes[FEISHU_SECRET_KEY] = FeishuWebhookUrlSchema.parse(feishu.webhookUrl.trim());
    }
    const candidate = this.candidateFromDisk(changes, removals);
    for (const source of input.sources) {
      const required = MARKET_SOURCE_MANIFEST[source].requiredEnv;
      if (required !== undefined && !candidate[required.key]?.trim())
        throw new Error(`${SOURCE_LABELS[source]} 尚未配置 ${required.key}`);
    }
    const apply = prepareApply(candidate);
    const lines = this.readFile()
      .split('\n')
      .filter(
        (line) =>
          ![...Object.keys(changes), ...removals].some((key) =>
            new RegExp(`^(?:export\\s+)?${key}\\s*=`).test(line.trim()),
          ),
      );
    while (lines.at(-1) === '') lines.pop();
    for (const [key, value] of Object.entries(changes)) lines.push(`${key}="${value}"`);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporary, `${lines.join('\n')}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
    // 落盘后**重读磁盘**：磁盘上不在 `SETTINGS_KEYS` 的键也要进运行时（见 candidateFromDisk）。
    // 同时按磁盘为准**删掉已移除的键**——否则 `clear:true` 之后内存里还留着旧密钥。
    const saved = parseEnvFile(this.readFile());
    const installed = new Set([...SETTINGS_KEYS, ...Object.keys(saved)]);
    const merged: Record<string, string | undefined> = { ...this.env };
    for (const key of Object.keys(saved)) merged[key] = saved[key];
    for (const key of Object.keys(merged)) {
      if (!installed.has(key)) continue;
      if (saved[key] === undefined) delete merged[key];
    }
    this.env = merged;
    apply();
    return this.read();
  }
}

export const createMarketSettingsHandler =
  (settings: MarketSettings) =>
  async (request: Request): Promise<Response> => {
    const respond = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
    try {
      if (request.method === 'GET') return respond({ ok: true, data: settings.read() });
      const transport = await readPluginJson(request);
      if (transport instanceof Response) return transport;
      const parsed = SaveMarketSettingsSchema.safeParse(transport.value);
      if (!parsed.success)
        return respond(invalidInput('请检查行情源顺序、服务地址和 API Key'), 400);
      for (const source of parsed.data.sources) {
        if (source === 'fuyao' && parsed.data.fuyao.apiKey !== undefined) continue;
        if (!settings.read().sources.find((item) => item.id === source)?.configured)
          return respond(invalidInput(`${SOURCE_LABELS[source]} 尚未配置 API 凭据`), 400);
      }
      return respond({ ok: true, data: settings.save(parsed.data) });
    } catch {
      return respond(
        { ok: false, error: { kind: 'internal', cause: '行情配置读取或保存失败，请重试' } },
        503,
      );
    }
  };
