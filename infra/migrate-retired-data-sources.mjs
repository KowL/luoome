import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRules = {
  LUOOME_MARKET_SOURCES: {
    allowed: ['eastmoney', 'tencent', 'sina', 'fuyao', 'xueqiu'],
    defaults: ['eastmoney', 'tencent', 'sina'],
  },
  LUOOME_STOCK_UNIVERSE_SOURCES: {
    allowed: ['eastmoney', 'sina'],
    defaults: ['eastmoney', 'sina'],
  },
};
const retiredKeys = new Set(['TUSHARE_TOKEN', 'TUSHARE_URL']);

function invalid(key) {
  const error = new Error('Invalid configuration');
  error.key = key;
  return error;
}

function parseValue(raw, key, strict = true) {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") {
    const end = raw.indexOf('#');
    const value = end < 0 ? raw : raw.slice(0, end);
    const trimmed = value.trimEnd();
    return { value: trimmed, prefix: '', suffix: raw.slice(trimmed.length) };
  }
  for (let index = 1; index < raw.length; index++) {
    if (raw[index] === '\\' && quote === '"') {
      index++;
    } else if (raw[index] === quote) {
      const suffix = raw.slice(index + 1);
      if (strict && !/^[ \t]*(?:#[^\r\n]*)?$/.test(suffix)) throw invalid(key);
      return { value: raw.slice(1, index), prefix: quote, suffix: quote + suffix };
    }
  }
  return undefined;
}

export function migrateContent(content) {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const lines =
    content
      .slice(bom.length)
      .match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)
      ?.filter(Boolean) ?? [];
  const changedKeys = new Set();
  const sourceCounts = Object.fromEntries(
    Object.entries(sourceRules).map(([key, rule]) => [key, rule.defaults.length]),
  );
  const output = [bom];
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    let ending = line.match(/(?:\r\n|\n|\r)$/)?.[0] ?? '';
    const body = line.slice(0, line.length - ending.length);
    const match = /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(.*)$/.exec(
      body,
    );
    const key = match?.[2];
    if (!key) {
      output.push(line);
      continue;
    }
    const targeted = retiredKeys.has(key) || Object.hasOwn(sourceRules, key);
    if (!targeted) {
      // Quoted multiline text may contain apparent assignments that are not active.
      let raw = match[4];
      while (
        (raw.startsWith('"') || raw.startsWith("'")) &&
        !parseValue(raw, key, false) &&
        index + 1 < lines.length
      ) {
        const next = lines[++index];
        raw += ending + next.replace(/(?:\r\n|\n|\r)$/, '');
        line += next;
        ending = next.match(/(?:\r\n|\n|\r)$/)?.[0] ?? '';
      }
      output.push(line);
      continue;
    }
    let raw = match[4];
    let parsed = parseValue(raw, key);
    while (!parsed && index + 1 < lines.length) {
      const next = lines[++index];
      raw += ending + next.replace(/(?:\r\n|\n|\r)$/, '');
      line += next;
      ending = next.match(/(?:\r\n|\n|\r)$/)?.[0] ?? '';
      parsed = parseValue(raw, key);
    }
    if (!parsed) throw invalid(key);
    if (retiredKeys.has(key)) {
      changedKeys.add(key);
      const comment = parsed.suffix.replace(/^["']?[ \t]*/, '');
      if (comment.startsWith('#'))
        output.push(`${match[1].match(/^[ \t]*/)[0]}${comment}${ending}`);
      continue;
    }
    const rule = sourceRules[key];
    const original = parsed.value.trim();
    const sources = original ? original.split(',').map((value) => value.trim().toLowerCase()) : [];
    const remaining = sources.filter((source) => source !== 'tushare');
    const result = remaining.length ? remaining : rule.defaults;
    if (
      result.length > 3 ||
      result.some((source) => !rule.allowed.includes(source)) ||
      new Set(result).size !== result.length
    ) {
      throw invalid(key);
    }
    sourceCounts[key] = result.length;
    if (sources.includes('tushare') || sources.length === 0) {
      changedKeys.add(key);
      output.push(
        `${match[1]}${key}${match[3]}${parsed.prefix}${result.join(',')}${parsed.suffix}${ending}`,
      );
    } else {
      output.push(line);
    }
  }
  return { content: output.join(''), changedKeys: [...changedKeys], sourceCounts };
}

export function resolveEnvFile(args, env = process.env, home = homedir()) {
  if (args.length === 0) return resolve(env.LUOOME_HOME || join(home, '.luoome'), '.env');
  if (args.length === 2 && args[0] === '--env-file' && args[1].trim()) return resolve(args[1]);
  throw new Error('Invalid arguments');
}

async function writePrivate(path, content) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function migrateFile(path) {
  const target = resolve(path);
  if (!(await lstat(target)).isFile()) throw new Error('Invalid file');
  const original = await readFile(target);
  // Reject lossy decoding so unrelated bytes never change during a migration.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original);
  const result = migrateContent(text);
  const { changedKeys, sourceCounts } = result;
  if (changedKeys.length === 0) return { changedKeys, sourceCounts };
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  await writePrivate(`${target}.backup-${stamp}`, original);
  const temporary = join(dirname(target), `.retired-data-sources-${stamp}.tmp`);
  try {
    await writePrivate(temporary, result.content);
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return { changedKeys, sourceCounts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await migrateFile(resolveEnvFile(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ invalidKeys: error.key ? [error.key] : [], errorCount: 1 })}\n`,
    );
    process.exitCode = 1;
  }
}
