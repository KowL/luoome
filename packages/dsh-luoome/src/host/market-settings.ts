import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, parse } from 'node:path';
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

/** 研究库（task-33）：本机路径配置，**不是凭据也不是通知通道**。 */
export const LOCAL_PATH_GUARDED_ID = 'research-vault' as const;
export const RESEARCH_VAULT_KEY = 'LUOOME_RESEARCH_VAULT' as const;
export const RESEARCH_VAULT_ID_KEY = 'LUOOME_RESEARCH_VAULT_ID' as const;
export const RESEARCH_ROOT_KEY = 'LUOOME_RESEARCH_ROOT' as const;
export const RESEARCH_MANAGED_ROOT_KEY = 'LUOOME_RESEARCH_MANAGED_ROOT' as const;
export const RESEARCH_MAX_TEXT_MB_KEY = 'LUOOME_RESEARCH_MAX_TEXT_MB' as const;
export const RESEARCH_MAX_ATTACHMENT_MB_KEY = 'LUOOME_RESEARCH_MAX_ATTACHMENT_MB' as const;

/** 四位高级配置的默认值（与 `apps/web/src/research-vault-settings.ts:29-40` 一致）。 */
export const RESEARCH_DEFAULTS = {
  researchRoot: 'Research',
  managedRoot: 'Research/Luoome',
  maxTextMb: 10,
  maxAttachmentMb: 100,
} as const;

const RESEARCH_VAULT_LABEL = '研究库（Obsidian Vault 路径）';

/**
 * 研究库路径的校验（task-33）——**逐条对应适配器的真实要求**，不是「看起来像路径就通过」：
 *
 * 1. **必须是绝对路径**：`adapters/src/research-vault/path-safety.ts:11`
 *    `if (!isAbsolute(vaultPath)) throw new Error('vault path must be absolute')`
 * 2. **必须已存在**：`path-safety.ts:12` 用 `realpathSync(vaultPath)`——
 *    路径不存在会抛 ENOENT，适配器**不会**替你创建根目录（只有写文件时才 `mkdir` 子目录）
 * 3. **必须是目录**：同上，`realpathSync` 指向文件时后续读写会失败；这里提前判
 * 4. **不能是文件系统根 / home 目录 / 当前工作目录 / 名为 `.obsidian` 的目录**：
 *    `path-safety.ts:15-22`（太宽或保留路径直接抛）
 *
 * **不在这里做**：可写性（适配器在真正写入时才失败）、是否 git 仓库
 * （那是 `LUOOME_RESEARCH_REMOTE_SYNC=git` 的额外要求，不是 vault 本身的）。
 */
const ResearchVaultPathSchema = z
  .string()
  .trim()
  .max(4_096)
  .refine((value) => !/[\r\n\0]/.test(value), '路径必须是单行文本')
  .refine((value) => isAbsolute(value), '必须填绝对路径（例如 /Users/you/Documents/Vault）')
  .superRefine((value, ctx) => {
    if (!existsSync(value)) {
      ctx.addIssue({ code: 'custom', message: '路径不存在，请先创建该目录' });
      return;
    }
    if (!statSync(value).isDirectory()) {
      ctx.addIssue({ code: 'custom', message: '路径存在但不是目录' });
      return;
    }
    // 与 `resolveSafeVaultRoot` 同一组「太宽/保留」判据（realpath 后比较，防符号链接绕过）。
    const root = realpathSync(value);
    const tooBroad =
      root === parse(root).root ||
      root === realpathSync(homedir()) ||
      root === realpathSync(process.cwd()) ||
      basename(root) === '.obsidian';
    if (tooBroad)
      ctx.addIssue({ code: 'custom', message: '路径太宽泛或是保留目录，请选一个具体的库目录' });
  });

/** 从 env 读正整数，非法/缺席时回落到默认值（**不因为一个坏值让整个面板读不出来**）。 */
const positiveIntFromEnv = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw?.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** 单行非空文本的可省字段（空串在进入前已被 transform 成 undefined）。 */
const singleLineOptional = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label}不能为空`)
    .refine((value) => !/[\r\n\0]/.test(value), `${label}必须是单行文本`)
    .optional();

/**
 * 研究库通道的保存入参（三态，与 task-32 同语义）：
 * - **缺席 / `''`** = 保留原值
 * - **非空** = 更新
 * - **`clearVault: true`** = 显式删除 `LUOOME_RESEARCH_VAULT` 与库 ID
 */
const ResearchVaultChannelSchema = z
  .object({
    /**
     * 三态里的「空串 = 保留」在**进入路径校验之前**就要短路：
     * 空串不是「合法路径」，直接交给 `ResearchVaultPathSchema` 会因为「非绝对路径」被拒。
     */
    path: z
      .string()
      .trim()
      .max(4_096)
      .optional()
      .transform((value) => (value === undefined || value.length === 0 ? undefined : value))
      .pipe(ResearchVaultPathSchema.optional()),
    /**
     * 研究目录 / 受管目录是**库内相对路径**（相对 `vaultPath`），
     * **不许**用 `ResearchVaultPathSchema`（那是绝对路径 + 存在性校验，语义完全不同）。
     * 判据照 `apps/web` 的 `singleLine()`：trim 后非空 + 单行。
     */
    researchRoot: singleLineOptional('研究目录'),
    managedRoot: singleLineOptional('受管目录'),
    /** 文本/附件上限：整数 + 上下界（与 apps/web 的 `int().min().max()` 一致）。 */
    maxTextMb: z.coerce.number().int().min(1).max(100).optional(),
    maxAttachmentMb: z.coerce.number().int().min(1).max(1_024).optional(),
    vaultId: z
      .string()
      .trim()
      .max(256)
      .refine((value) => !/[\r\n\0]/.test(value), '库 ID 必须是单行文本')
      .optional(),
    clearVault: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) => !(value.clearVault && value.path !== undefined && value.path.trim().length > 0),
    'clearVault 与 path 不能同时给出',
  );

/**
 * 飞书 Webhook 的**安全边界**（task-32 从 `apps/web/src/feishu-settings.ts` 原样搬过来）：
 * 只接受 `https:` + `open.feishu.cn` + `/open-apis/bot/v2/hook/<token>` + 无 userinfo/query/hash。
 *
 * **这是白名单，不是格式校验**：放宽任何一条都会让密钥/内容被发到非飞书域名。
 */
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
    /** 其它需要凭据的源（Tushare 等）；键 = 源 id。 */
    credentials: z.record(z.string(), CredentialSectionSchema).optional().default({}),
    /** 非行情源通道（task-32）：飞书通知。与 `credentials` 并列，不混进 manifest。 */
    notifications: z.object({ feishu: FeishuChannelSchema.optional() }).strict().optional(),
    /** 本机路径配置（task-33）：研究库。**既不是凭据也不是通知通道**。 */
    localPaths: z
      .object({ researchVault: ResearchVaultChannelSchema.optional() })
      .strict()
      .optional(),
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
  tushare: 'Tushare',
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
  // task-33：研究库的两个键同样必须在这里，否则重启后磁盘上的配置读不进运行时。
  RESEARCH_VAULT_KEY,
  RESEARCH_VAULT_ID_KEY,
  RESEARCH_ROOT_KEY,
  RESEARCH_MANAGED_ROOT_KEY,
  RESEARCH_MAX_TEXT_MB_KEY,
  RESEARCH_MAX_ATTACHMENT_MB_KEY,
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
    | {
        readonly kind: 'local-path';
        readonly id: typeof LOCAL_PATH_GUARDED_ID;
        readonly label: string;
        readonly envKey: typeof RESEARCH_VAULT_KEY;
        readonly configured: boolean;
        /**
         * 研究库路径**可以回显**：它不是秘密（是用户自己的目录），
         * 而且「我现在指向哪个库」正是用户需要核对的信息。
         */
        readonly path?: string;
        /** 库 ID 也回显——它只是库的标识（缺省时适配器按路径哈希生成），不含凭据。 */
        readonly vaultId?: string;
        /** 库内研究根（相对 vaultPath），未配置时回显默认值。 */
        readonly researchRoot: string;
        readonly managedRoot: string;
        readonly maxTextMb: number;
        readonly maxAttachmentMb: number;
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
        // 本机路径配置：既不是凭据（无密钥）也不是通知通道（不发消息）。
        {
          kind: 'local-path' as const,
          id: LOCAL_PATH_GUARDED_ID,
          label: RESEARCH_VAULT_LABEL,
          envKey: RESEARCH_VAULT_KEY,
          configured: Boolean(this.env[RESEARCH_VAULT_KEY]?.trim()),
          ...(this.env[RESEARCH_VAULT_KEY]?.trim()
            ? { path: this.env[RESEARCH_VAULT_KEY]?.trim() }
            : {}),
          ...(this.env[RESEARCH_VAULT_ID_KEY]?.trim()
            ? { vaultId: this.env[RESEARCH_VAULT_ID_KEY]?.trim() }
            : {}),
          // 四项高级配置：未配置时回显**默认值**（空库首次打开要能看见 Research / 10 / 100）。
          researchRoot: this.env[RESEARCH_ROOT_KEY]?.trim() || RESEARCH_DEFAULTS.researchRoot,
          managedRoot: this.env[RESEARCH_MANAGED_ROOT_KEY]?.trim() || RESEARCH_DEFAULTS.managedRoot,
          maxTextMb: positiveIntFromEnv(
            this.env[RESEARCH_MAX_TEXT_MB_KEY],
            RESEARCH_DEFAULTS.maxTextMb,
          ),
          maxAttachmentMb: positiveIntFromEnv(
            this.env[RESEARCH_MAX_ATTACHMENT_MB_KEY],
            RESEARCH_DEFAULTS.maxAttachmentMb,
          ),
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
    // 研究库（task-33）：同三态——空串/缺席保留，`clearVault` 才删除两个键。
    const vault = input.localPaths?.researchVault;
    if (vault !== undefined) {
      if (vault.clearVault) {
        removals.add(RESEARCH_VAULT_KEY);
        removals.add(RESEARCH_VAULT_ID_KEY);
      } else {
        if (vault.path !== undefined && vault.path.trim().length > 0)
          changes[RESEARCH_VAULT_KEY] = ResearchVaultPathSchema.parse(vault.path.trim());
        // 库 ID 可选：不填就让适配器按路径哈希生成（factory.ts 有 `?.` 判断）。
        if (vault.vaultId !== undefined && vault.vaultId.trim().length > 0)
          changes[RESEARCH_VAULT_ID_KEY] = vault.vaultId.trim();
        // 四项高级配置：同样三态（缺席保留，非空更新）。
        if (vault.researchRoot !== undefined && vault.researchRoot.trim().length > 0)
          changes[RESEARCH_ROOT_KEY] = vault.researchRoot.trim();
        if (vault.managedRoot !== undefined && vault.managedRoot.trim().length > 0)
          changes[RESEARCH_MANAGED_ROOT_KEY] = vault.managedRoot.trim();
        if (vault.maxTextMb !== undefined)
          changes[RESEARCH_MAX_TEXT_MB_KEY] = String(vault.maxTextMb);
        if (vault.maxAttachmentMb !== undefined)
          changes[RESEARCH_MAX_ATTACHMENT_MB_KEY] = String(vault.maxAttachmentMb);
      }
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
