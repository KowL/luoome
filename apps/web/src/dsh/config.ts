import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_FETCH_MANIFEST_ENTRY } from '@luoome/dsh-bridge/protocol';
import { z } from 'zod';
import type { DshChatRuntimeOptions } from './chat-runtime.js';

export interface DshDevelopmentConfig {
  readonly development: true;
  readonly nodePath: string;
  readonly hostEntry: string;
  readonly cwd: string;
  readonly native?: NonNullable<DshChatRuntimeOptions['native']>;
}

export const loadDshDevelopmentConfig = (
  env: Readonly<Record<string, string | undefined>>,
  environment: 'development' | 'production',
): DshDevelopmentConfig | undefined => {
  const runtime = z.enum(['ai-sdk', 'dsh']).parse(env.LUOOME_CHAT_RUNTIME ?? 'ai-sdk');
  if (runtime === 'ai-sdk') return undefined;
  if (environment !== 'development' || env.LUOOME_DSH_DEVELOPMENT !== 'true')
    throw new Error('DSH Chat requires development environment and LUOOME_DSH_DEVELOPMENT=true');
  const nodePath = env.LUOOME_DSH_NODE_PATH;
  if (nodePath === undefined || !isAbsolute(nodePath))
    throw new Error('DSH requires explicit absolute LUOOME_DSH_NODE_PATH');
  const hostEntry =
    env.LUOOME_DSH_HOST_ENTRY ??
    fileURLToPath(new URL('../../../agent-runtime/dist/index.js', import.meta.url));
  if (!isAbsolute(hostEntry)) throw new Error('DSH Host entry must be absolute');
  const fixtureFile = env.LUOOME_DSH_WEB_FIXTURES_FILE;
  const allowNative = env.LUOOME_DSH_ALLOW_WEB_FIXTURES === 'true';
  if ((fixtureFile !== undefined) !== allowNative)
    throw new Error('DSH webpage fixtures require separate authorization and an explicit file');
  let native: DshChatRuntimeOptions['native'];
  if (fixtureFile !== undefined) {
    if (!isAbsolute(fixtureFile)) throw new Error('DSH webpage fixture path must be absolute');
    const stat = statSync(fixtureFile);
    if (!stat.isFile() || stat.size > 65_536) throw new Error('Invalid DSH webpage fixture file');
    const fixtures = z
      .record(z.url(), z.string().max(100_000))
      .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 16)
      .parse(JSON.parse(readFileSync(fixtureFile, 'utf8')));
    native = { authorized: true, entry: WEB_FETCH_MANIFEST_ENTRY, fixtures };
  }
  return {
    development: true,
    nodePath,
    hostEntry,
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    ...(native === undefined ? {} : { native }),
  };
};
