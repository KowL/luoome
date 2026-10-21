import { readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { type HostedProductPolicyVersion, HostedProductPolicyVersionSchema } from '@luoome/core';
import { z } from 'zod';

export const RuntimeModeSchema = z.enum(['local', 'hosted']);
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

export const resolveRuntimeMode = (
  env: Record<string, string | undefined> = process.env,
): RuntimeMode => RuntimeModeSchema.parse(env.LUOOME_MODE ?? 'local');

export const assertHostedEnvironmentIsolation = (
  args: readonly string[] = process.execArgv,
): void => {
  if (!args.includes('--no-env-file'))
    throw new Error('Web service requires bun --no-env-file to disable implicit dotenv loading');
};

export interface HostedConfig {
  readonly mode: 'hosted';
  readonly environment: 'development' | 'production';
  readonly dataRoot: string;
  readonly deletionLedgerRoot: string;
  readonly publicOrigin: string;
  readonly allowInsecureHttp: boolean;
  readonly authSecret: string;
  readonly productPolicyVersion: HostedProductPolicyVersion;
  readonly providerMode: 'fixture' | 'configured';
  readonly exposeWrite: boolean;
  readonly exposeExternal: boolean;
  readonly runtimeLimit: number;
  readonly registrationLimit: number;
  readonly registrationEnabled: boolean;
  readonly trustedProxyIp: string | null;
  readonly adminEmails: readonly string[];
  /** 订阅流程未开放时可关闭权益门禁；关闭后写操作与后台任务不再要求有效服务期。 */
  readonly entitlementRequired: boolean;
}

const ConfigSchema = z.object({
  environment: z.enum(['development', 'production']),
  dataRoot: z.string().min(1).refine(isAbsolute),
  publicOrigin: z.url(),
  authSecret: z.string().min(32),
  productPolicyVersion: HostedProductPolicyVersionSchema.default('hosted-web-v2'),
  providerMode: z.enum(['fixture', 'configured']).default('configured'),
  runtimeLimit: z.coerce.number().int().min(1).max(100).default(16),
  registrationLimit: z.coerce.number().int().min(1).max(100).default(30),
});

export const loadHostedConfig = (
  env: Record<string, string | undefined> = process.env,
): HostedConfig => {
  let authSecret = env.HOSTED_AUTH_SECRET;
  if (env.HOSTED_AUTH_SECRET_FILE !== undefined) {
    if (authSecret !== undefined) throw new Error('configure only one hosted auth secret source');
    const stat = statSync(env.HOSTED_AUTH_SECRET_FILE);
    if (!stat.isFile() || stat.size > 4096) throw new Error('invalid hosted auth secret file');
    authSecret = readFileSync(env.HOSTED_AUTH_SECRET_FILE, 'utf8').trim();
  }
  const parsed = ConfigSchema.safeParse({
    environment: env.HOSTED_ENVIRONMENT,
    dataRoot: env.HOSTED_DATA_ROOT,
    publicOrigin: env.PUBLIC_ORIGIN,
    authSecret,
    productPolicyVersion: env.HOSTED_PRODUCT_POLICY,
    providerMode: env.HOSTED_PROVIDER_MODE,
    ...(env.HOSTED_RUNTIME_LIMIT === undefined ? {} : { runtimeLimit: env.HOSTED_RUNTIME_LIMIT }),
    ...(env.HOSTED_REGISTRATION_LIMIT === undefined
      ? {}
      : { registrationLimit: env.HOSTED_REGISTRATION_LIMIT }),
  });
  if (!parsed.success) {
    throw new Error(
      `invalid hosted configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  const config = parsed.data;
  const allowInsecureHttp =
    z.enum(['true', 'false']).default('false').parse(env.HOSTED_ALLOW_INSECURE_HTTP) === 'true';
  const url = new URL(config.publicOrigin);
  if (
    url.origin !== config.publicOrigin ||
    url.username !== '' ||
    url.password !== '' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowInsecureHttp))
  ) {
    throw new Error(
      'PUBLIC_ORIGIN must be a fixed HTTPS origin; HTTP requires HOSTED_ALLOW_INSECURE_HTTP=true',
    );
  }
  if (config.environment === 'production' && config.providerMode === 'fixture') {
    throw new Error('fixture providers cannot serve production');
  }
  if (env.LUOOME_EXPOSE_TRADE === 'true') {
    throw new Error('hosted mode forbids trade capability');
  }
  const dataRoot = resolve(config.dataRoot);
  const deletionLedgerRoot =
    env.HOSTED_DELETION_LEDGER_ROOT === undefined
      ? resolve(dataRoot, 'deletion-ledger')
      : resolve(env.HOSTED_DELETION_LEDGER_ROOT);
  if (env.HOSTED_DELETION_LEDGER_ROOT !== undefined && !isAbsolute(env.HOSTED_DELETION_LEDGER_ROOT))
    throw new Error('HOSTED_DELETION_LEDGER_ROOT must be absolute');
  if (
    config.environment === 'production' &&
    (env.HOSTED_DELETION_LEDGER_ROOT === undefined ||
      deletionLedgerRoot === dataRoot ||
      deletionLedgerRoot.startsWith(`${dataRoot}/`))
  )
    throw new Error('production requires an independent deletion ledger outside HOSTED_DATA_ROOT');
  const trustedProxyIp = env.HOSTED_TRUSTED_PROXY_IP ?? null;
  if (trustedProxyIp !== null && isIP(trustedProxyIp) === 0)
    throw new Error('HOSTED_TRUSTED_PROXY_IP must be one explicit IP address');
  const adminEmails = (env.HOSTED_ADMIN_EMAILS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  if (adminEmails.some((value) => !z.email().safeParse(value).success))
    throw new Error('HOSTED_ADMIN_EMAILS must be a comma-separated list of email addresses');
  return Object.freeze({
    mode: 'hosted',
    ...config,
    allowInsecureHttp,
    dataRoot,
    deletionLedgerRoot,
    trustedProxyIp,
    adminEmails: Object.freeze(adminEmails),
    exposeWrite: env.LUOOME_EXPOSE_WRITE === 'true',
    exposeExternal: env.LUOOME_EXPOSE_EXTERNAL === 'true',
    registrationEnabled: env.HOSTED_REGISTRATION_ENABLED === 'true',
    entitlementRequired: env.HOSTED_ENTITLEMENT_REQUIRED !== 'false',
  });
};
