import { createHash } from 'node:crypto';
import { constants, promises as fs, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, parse, resolve, sep } from 'node:path';

import type { ResearchVaultAdapterLike, ResearchVaultEntry } from '@luoome/core';

const hash = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const safeRelative = (value: string): string => {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('unsafe relative path');
  }
  return normalized;
};

const ignored = (name: string): boolean =>
  name.startsWith('.') || name === 'Thumbs.db' || name.endsWith('~');

const positiveBytes = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
};

export interface ObsidianVaultOptions {
  readonly vaultPath: string;
  readonly researchRoot?: string;
  readonly managedRoot?: string;
  readonly vaultId?: string;
  readonly maxTextBytes?: number;
  readonly maxAttachmentBytes?: number;
}

export class ObsidianVaultAdapter implements ResearchVaultAdapterLike {
  readonly name = 'obsidian-vault';
  readonly vaultId: string;
  private readonly root: string;
  private readonly researchRoot: string;
  private readonly managedRoot: string;
  private readonly maxTextBytes: number;
  private readonly maxAttachmentBytes: number;

  constructor(options: ObsidianVaultOptions) {
    if (!isAbsolute(options.vaultPath)) throw new Error('vault path must be absolute');
    this.root = realpathSync(options.vaultPath);
    const filesystemRoot = parse(this.root).root;
    const currentProject = realpathSync(process.cwd());
    if (
      this.root === filesystemRoot ||
      this.root === realpathSync(homedir()) ||
      this.root === currentProject ||
      basename(this.root) === '.obsidian'
    ) {
      throw new Error('vault path is too broad or reserved');
    }

    this.researchRoot = safeRelative(options.researchRoot ?? 'Research');
    this.managedRoot = safeRelative(options.managedRoot ?? 'Research/Luoome');
    if (this.researchRoot !== '.' && !this.managedRoot.startsWith(`${this.researchRoot}/`)) {
      throw new Error('managed root must be a child of research root');
    }
    this.vaultId = options.vaultId?.trim() || hash(this.root).slice(0, 16);
    this.maxTextBytes = positiveBytes(options.maxTextBytes ?? 10 * 1024 * 1024, 'maxTextBytes');
    this.maxAttachmentBytes = positiveBytes(
      options.maxAttachmentBytes ?? 100 * 1024 * 1024,
      'maxAttachmentBytes',
    );
  }

  private lexicalTarget(relativePath: string): { readonly rel: string; readonly target: string } {
    const rel = safeRelative(relativePath);
    const target = resolve(this.root, rel);
    if (!isInside(this.root, target)) throw new Error('path escapes vault');
    return { rel, target };
  }

  private async existingTarget(
    relativePath: string,
  ): Promise<{ readonly rel: string; readonly target: string }> {
    const { rel, target } = this.lexicalTarget(relativePath);
    const realTarget = await fs.realpath(target);
    if (!isInside(this.root, realTarget)) throw new Error('path escapes vault');
    return { rel, target: realTarget };
  }

  private async writableTarget(
    relativePath: string,
  ): Promise<{ readonly rel: string; readonly target: string }> {
    const resolved = this.lexicalTarget(relativePath);
    let ancestor = dirname(resolved.target);
    while (true) {
      try {
        const realAncestor = await fs.realpath(ancestor);
        if (!isInside(this.root, realAncestor)) throw new Error('path escapes vault');
        return resolved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }

  private async readFile(relativePath: string, maxBytes: number): Promise<Buffer> {
    const { target } = await this.existingTarget(relativePath);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('vault entry is not a regular file');
      if (stat.size > maxBytes) throw new Error('file exceeds configured size limit');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async scan(input?: {
    readonly roots?: readonly string[];
  }): Promise<readonly ResearchVaultEntry[]> {
    const roots = input?.roots?.length ? input.roots.map(safeRelative) : [this.researchRoot];
    const output: ResearchVaultEntry[] = [];

    const walk = async (relRoot: string): Promise<void> => {
      const { target } = await this.existingTarget(relRoot);
      const dir = await fs.opendir(target);
      for await (const entry of dir) {
        if (ignored(entry.name) || entry.isSymbolicLink()) continue;
        const rel = relRoot === '.' ? entry.name : `${relRoot}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(rel);
          continue;
        }
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue;
        const content = await this.readFile(rel, this.maxTextBytes);
        const stat = await fs.stat(join(this.root, rel));
        output.push({
          relativePath: rel,
          size: stat.size,
          modifiedAt: stat.mtime,
          contentHash: hash(content),
        });
      }
    };

    for (const root of roots) await walk(root);
    return output.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  async readText(input: {
    readonly relativePath: string;
    readonly maxBytes: number;
  }): Promise<string> {
    const maxBytes = Math.min(positiveBytes(input.maxBytes, 'maxBytes'), this.maxTextBytes);
    return (await this.readFile(input.relativePath, maxBytes)).toString('utf8');
  }

  async createManagedDocument(input: {
    readonly relativePath: string;
    readonly content: string;
  }): Promise<ResearchVaultEntry> {
    const rel = safeRelative(input.relativePath);
    if (!rel.startsWith(`${this.managedRoot}/`)) {
      throw new Error('managed writes must stay inside managed root');
    }
    const content = Buffer.from(input.content, 'utf8');
    if (content.byteLength > this.maxTextBytes)
      throw new Error('file exceeds configured size limit');
    const { target } = await this.writableTarget(rel);
    await fs.mkdir(dirname(target), { recursive: true });
    try {
      await fs.lstat(target);
      throw new Error('target already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const tmp = `${target}.luoome-${process.pid}-${Date.now()}.tmp`;
    try {
      const handle = await fs.open(tmp, 'wx');
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, target);
    } catch (error) {
      await fs.unlink(tmp).catch(() => undefined);
      throw error;
    }
    const stat = await fs.stat(target);
    return {
      relativePath: rel,
      size: stat.size,
      modifiedAt: stat.mtime,
      contentHash: hash(content),
    };
  }

  async importAttachment(input: {
    readonly suggestedName: string;
    readonly content: Uint8Array;
    readonly mediaType: string;
  }): Promise<ResearchVaultEntry> {
    if (input.content.byteLength > this.maxAttachmentBytes) {
      throw new Error('attachment exceeds configured size limit');
    }
    if (!/^[a-z]+\/[a-z0-9.+-]+$/i.test(input.mediaType)) throw new Error('invalid media type');
    const ext = extname(input.suggestedName)
      .replace(/[^a-zA-Z0-9.]/g, '')
      .slice(0, 10);
    const rel = `${this.managedRoot}/Attachments/${hash(input.content)}${ext}`;
    const { target } = await this.writableTarget(rel);
    await fs.mkdir(dirname(target), { recursive: true });
    try {
      const handle = await fs.open(target, 'wx');
      try {
        await handle.writeFile(input.content);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.readFile(rel, this.maxAttachmentBytes);
      if (hash(existing) !== hash(input.content)) throw new Error('attachment hash collision');
    }
    const stat = await fs.stat(target);
    return {
      relativePath: rel,
      size: stat.size,
      modifiedAt: stat.mtime,
      contentHash: hash(input.content),
    };
  }

  buildOpenUri(relativePath: string): string {
    const rel = safeRelative(relativePath);
    return `obsidian://open?vault=${encodeURIComponent(this.vaultId)}&file=${encodeURIComponent(rel)}`;
  }
}

export interface ParsedMarkdown {
  readonly frontmatter: Record<string, string | string[] | undefined>;
  readonly body: string;
}

const unquote = (value: string): string => value.replace(/^(['"])(.*)\1$/, '$2');

export const parseResearchMarkdown = (content: string): ParsedMarkdown => {
  if (!content.startsWith('---\n')) return { frontmatter: {}, body: content };
  const end = content.indexOf('\n---', 4);
  if (end < 0) throw new Error('frontmatter terminator missing');
  const frontmatter: Record<string, string | string[] | undefined> = {};
  let current: string | undefined;
  for (const line of content.slice(4, end).split('\n')) {
    const list = line.match(/^\s+-\s+(.*)$/);
    if (list?.[1] !== undefined && current !== undefined) {
      const previous = frontmatter[current];
      frontmatter[current] = [
        ...(Array.isArray(previous) ? previous : []),
        unquote(list[1].trim()),
      ];
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    current = match[1];
    const raw = match[2].trim();
    frontmatter[current] = raw === '' ? undefined : unquote(raw);
  }
  return { frontmatter, body: content.slice(end + 4).replace(/^\n/, '') };
};
