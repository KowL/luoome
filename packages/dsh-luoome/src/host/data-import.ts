// T48 专用有界上传载体（host 侧 IO）。
//
// 边界：
// - 只接受 `application/octet-stream` 的原始字节，不接受 base64/JSON 载体；
//   通用 64 KiB 操作接口因此永远承载不了数据库文件。
// - 服务端逐 chunk 计字节与 SHA-256，超出上限立即中止并清理；不信任 Content-Length。
// - 暂存目录 0700、文件 0600、服务器命名（opaque uploadId），原始文件名不参与路径。
// - 客户端只拿到 `uploadId + digest + size + expiresAt`；本机路径永不回显。
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type {
  DataImportBackup,
  DataImportSnapshot,
  DataImportStagedUpload,
  DataImportStagingAdapter,
  DataImportStorageSchema,
  ToolResult,
} from '@luoome/core';
import {
  DATA_IMPORT_BUSINESS_TABLES,
  readDataImportStorageSchema,
  readSqliteImportSnapshot,
} from '@luoome/db/node';
import { z } from 'zod';
import { readPluginJson } from './routes.js';

const SQLITE_MAGIC = 'SQLite format 3\u0000';
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
const DEFAULT_QUOTA_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_STAGED = 2;
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_UPLOADS_PER_WINDOW = 6;
const DEFAULT_WINDOW_MS = 60_000;

export interface DataImportStagingOptions {
  /** 插件 home 下的暂存目录；本模块负责创建为 0700。 */
  readonly directory: string;
  readonly userId: string;
  readonly accountId: string;
  readonly now: () => number;
  /** 目标库当前存储 schema（来自共享主连接），用于拒绝非当前版本的快照。 */
  readonly targetSchema: () => DataImportStorageSchema;
  readonly maxFileBytes?: number;
  readonly quotaBytes?: number;
  readonly maxStaged?: number;
  readonly ttlMs?: number;
  readonly maxUploadsPerWindow?: number;
  readonly windowMs?: number;
  /** 提交前复核备份文件；未注入时提交拒绝（无法证明安全网有效）。 */
  readonly backups?: Pick<DataImportBackupStore, 'verify'>;
}

export interface DataImportStaging extends DataImportStagingAdapter {
  stage(body: ReadableStream<Uint8Array> | null): Promise<DataImportStagedUpload>;
  dispose(): void;
}

interface StagedEntry extends DataImportStagedUpload {
  readonly path: string;
}

export class DataImportStagingError extends Error {
  constructor(
    readonly status: 400 | 413 | 415 | 429 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'DataImportStagingError';
  }
}

export const createDataImportStaging = (options: DataImportStagingOptions): DataImportStaging => {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
  const maxStaged = options.maxStaged ?? DEFAULT_MAX_STAGED;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxUploadsPerWindow = options.maxUploadsPerWindow ?? DEFAULT_UPLOADS_PER_WINDOW;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const staged = new Map<string, StagedEntry>();
  const uploadWindow: number[] = [];
  let disposed = false;

  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(options.directory, 0o700);
  } catch {
    // 非 POSIX 或已存在且权限不同：不因 chmod 失败拒绝启动，下面仍按服务器命名写文件。
  }

  const remove = (entry: StagedEntry): void => {
    staged.delete(entry.uploadId);
    try {
      rmSync(entry.path, { force: true });
    } catch {
      // 清理失败不影响正确性：TTL 与配额在下次 sweep 时重算。
    }
  };
  const sweep = (): void => {
    const now = options.now();
    for (const entry of [...staged.values()]) if (now >= entry.expiresAt) remove(entry);
    // 进程重启后遗留的暂存文件不属于任何会话，直接清掉（不猜归属）。
    for (const name of readdirSync(options.directory)) {
      if (name.endsWith('.db')) continue;
      try {
        rmSync(join(options.directory, name), { force: true });
      } catch {
        // ignore
      }
    }
  };

  const stage = async (
    body: ReadableStream<Uint8Array> | null,
  ): Promise<DataImportStagedUpload> => {
    if (disposed) throw new DataImportStagingError(503, '导入载体已关闭');
    sweep();
    const now = options.now();
    while (uploadWindow.length > 0 && now - (uploadWindow[0] ?? 0) > windowMs) uploadWindow.shift();
    if (uploadWindow.length >= maxUploadsPerWindow)
      throw new DataImportStagingError(429, '上传过于频繁，请稍后重试');
    if (staged.size >= maxStaged) throw new DataImportStagingError(429, '暂存文件数量已达上限');
    const used = [...staged.values()].reduce((sum, entry) => sum + entry.size, 0);
    if (used >= quotaBytes) throw new DataImportStagingError(429, '暂存配额已用尽');
    if (body === null) throw new DataImportStagingError(400, '缺少上传内容');

    const uploadId = randomBytes(16).toString('hex');
    const path = join(options.directory, `${uploadId}.db`);
    const fd = openSync(path, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    let headerChecked = false;
    let header = Buffer.alloc(0);
    const reader = body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const bytes = chunk.value;
        size += bytes.byteLength;
        if (size > maxFileBytes) throw new DataImportStagingError(413, '上传超出大小上限');
        if (size + used > quotaBytes) throw new DataImportStagingError(413, '暂存配额已用尽');
        if (!headerChecked) {
          header = Buffer.concat([header, Buffer.from(bytes)]);
          if (header.byteLength >= 16) {
            if (header.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC)
              throw new DataImportStagingError(415, '仅支持 SQLite 二进制快照');
            headerChecked = true;
          }
        }
        hash.update(bytes);
        writeSync(fd, bytes);
      }
      if (!headerChecked) throw new DataImportStagingError(415, '仅支持 SQLite 二进制快照');
      if (size === 0) throw new DataImportStagingError(400, '上传内容为空');
    } catch (error) {
      closeSync(fd);
      rmSync(path, { force: true });
      throw error;
    } finally {
      reader.releaseLock();
    }
    closeSync(fd);
    chmodSync(path, 0o600);
    uploadWindow.push(now);
    const entry: StagedEntry = {
      uploadId,
      archiveDigest: hash.digest('hex'),
      size,
      userId: options.userId,
      accountId: options.accountId,
      createdAt: now,
      expiresAt: now + ttlMs,
      path,
    };
    staged.set(uploadId, entry);
    const { path: _path, ...publicEntry } = entry;
    return publicEntry;
  };

  const find = (uploadId: string): StagedEntry | null => {
    sweep();
    const entry = staged.get(uploadId);
    if (entry === undefined) return null;
    if (options.now() >= entry.expiresAt) {
      remove(entry);
      return null;
    }
    return entry;
  };

  return {
    stage,
    async describe(uploadId: string) {
      const entry = find(uploadId);
      if (entry === null) return null;
      const { path: _path, ...publicEntry } = entry;
      return publicEntry;
    },
    async load(uploadId: string): Promise<DataImportSnapshot> {
      const entry = find(uploadId);
      if (entry === null) throw new DataImportStagingError(400, '暂存快照不存在或已过期');
      const stat = statSync(entry.path);
      if (stat.size !== entry.size) throw new DataImportStagingError(400, '暂存快照在封存后被改写');
      return readSqliteImportSnapshot(
        entry.path,
        { userId: options.userId, accountId: options.accountId },
        options.targetSchema(),
      );
    },
    async verifyBackup(backupId: string) {
      return options.backups === undefined ? false : options.backups.verify(backupId);
    },
    dispose() {
      disposed = true;
      for (const entry of [...staged.values()]) remove(entry);
    },
  };
};

const noStore = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * `POST /api/luoome/import/upload`：octet-stream 专用载体。
 *
 * 同源与 owner 由 `/api/luoome` 前缀层（Connection.admit + owner）保证，这里再独立复核
 * Origin 与 Content-Type，避免以后被别的前缀复用而丢掉这两条。
 */
export const createDataImportUploadHandler =
  (staging: DataImportStaging) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== 'POST')
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return noStore(403, {
        ok: false,
        error: { kind: 'permission_denied', required: 'same-origin request' },
      });
    if (
      request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/octet-stream'
    )
      return noStore(415, {
        ok: false,
        error: { kind: 'invalid_input', message: 'octet-stream required', issues: [] },
      });
    try {
      const uploaded = await staging.stage(request.body);
      return noStore(200, { ok: true, data: uploaded });
    } catch (error) {
      if (error instanceof DataImportStagingError)
        return noStore(error.status, {
          ok: false,
          error: { kind: 'invalid_input', message: error.message, issues: [] },
        });
      return noStore(503, {
        ok: false,
        error: { kind: 'unavailable', message: 'upload unavailable' },
      });
    }
  };

/**
 * `POST /api/luoome/import/preview`：小 JSON（`{uploadId}`）只读预检。
 * 它不创建 Operation、不写目标库；预检本身没有副作用，因此不需要账户 lease。
 */
export const createDataImportPreviewHandler =
  (invoke: (uploadId: string) => Promise<ToolResult<unknown>>) =>
  async (request: Request): Promise<Response> => {
    const transport = await readPluginJson(request);
    if (transport instanceof Response) return transport;
    const parsed = z
      .object({ uploadId: z.string().regex(/^[a-f0-9]{32,64}$/) })
      .strict()
      .safeParse(transport.value);
    if (!parsed.success)
      return noStore(400, {
        ok: false,
        error: { kind: 'invalid_input', message: 'Invalid preview envelope', issues: [] },
      });
    const result = await invoke(parsed.data.uploadId);
    return noStore(result.ok ? 200 : 400, result);
  };

export interface DataImportBackupStoreOptions {
  /** 备份目录；本模块创建为 0700，文件 0600。 */
  readonly directory: string;
  readonly userId: string;
  readonly accountId: string;
  readonly now: () => number;
  /** 一致性备份实现（生产注入 node:sqlite 的 backup；测试可注入失败）。 */
  readonly backupDatabase: (path: string) => Promise<void>;
  /** 保留最近 N 份备份；更早的删除，避免长期运行无限增长。 */
  readonly maxKept?: number;
}

export interface DataImportBackupStore {
  create(input: {
    readonly archiveDigest: string;
    readonly targetDigest: string;
  }): Promise<DataImportBackup>;
  describe(backupId: string): Promise<DataImportBackup | null>;
  /** 复核文件仍存在且字节未变（事务外）。 */
  verify(backupId: string): Promise<boolean>;
  dispose(): void;
}

const DEFAULT_MAX_BACKUPS = 10;

/**
 * 恢复前一致性备份。必须在导入事务**之外**生成（事务内不 IO、不 await）：
 * 备份是 `node:sqlite` 的 backup 复制，运行期与单写实例的写串行，因此是自洽快照。
 * 备份只按 opaque id 暴露，路径永不回显。
 */
export const createDataImportBackups = (
  options: DataImportBackupStoreOptions,
): DataImportBackupStore => {
  const maxKept = options.maxKept ?? DEFAULT_MAX_BACKUPS;
  const entries = new Map<string, { readonly path: string; readonly backup: DataImportBackup }>();
  let disposed = false;
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(options.directory, 0o700);
  } catch {
    // 非 POSIX：不影响正确性。
  }

  /**
   * 一致性备份的**创建时校验**：以 immutable 只读打开副本，跑 `PRAGMA integrity_check`，
   * 并要求当前 manifest 的业务表全部存在。不通过就不登记——否则 UI 会展示一份「无法恢复的
   * 安全网」，正是本项目禁止的名实不符。
   */
  const verifyBackupFile = (path: string): void => {
    const uri = pathToFileURL(path);
    uri.searchParams.set('mode', 'ro');
    uri.searchParams.set('immutable', '1');
    const db = new DatabaseSync(uri.toString(), { readOnly: true, allowExtension: false });
    try {
      const integrity = db.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
        throw new DataImportStagingError(503, '备份完整性校验失败');
      const schema = readDataImportStorageSchema(db);
      for (const table of DATA_IMPORT_BUSINESS_TABLES) {
        const columns = schema[table]?.columns;
        if (columns === undefined || columns.length === 0)
          throw new DataImportStagingError(503, `备份缺少业务表: ${table}`);
      }
    } finally {
      db.close();
    }
  };

  const evict = (): void => {
    const ordered = [...entries.values()].sort((a, b) => a.backup.createdAt - b.backup.createdAt);
    while (ordered.length > maxKept) {
      const oldest = ordered.shift();
      if (oldest === undefined) break;
      entries.delete(oldest.backup.backupId);
      try {
        rmSync(oldest.path, { force: true });
      } catch {
        // 删除失败不影响已生成的备份记录。
      }
    }
  };

  return {
    async create(input) {
      if (disposed) throw new DataImportStagingError(503, '备份载体已关闭');
      const backupId = randomBytes(16).toString('hex');
      const path = join(options.directory, `${backupId}.db`);
      // 备份失败（磁盘满、权限、SQLITE_BUSY）直接抛出：调用方不得继续提交。
      await options.backupDatabase(path);
      chmodSync(path, 0o600);
      try {
        verifyBackupFile(path);
      } catch (error) {
        // 校验失败：删掉这份不可用的副本，绝不登记成「安全网」。
        try {
          rmSync(path, { force: true });
        } catch {
          // 清理失败也不登记。
        }
        throw error;
      }
      const stat = statSync(path);
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
      const backup: DataImportBackup = {
        backupId,
        archiveDigest: input.archiveDigest,
        targetDigest: input.targetDigest,
        digest,
        size: stat.size,
        createdAt: options.now(),
      };
      entries.set(backupId, { path, backup });
      evict();
      return backup;
    },
    async describe(backupId) {
      return entries.get(backupId)?.backup ?? null;
    },
    async verify(backupId) {
      const entry = entries.get(backupId);
      if (entry === undefined) return false;
      try {
        if (statSync(entry.path).size !== entry.backup.size) return false;
        return (
          createHash('sha256').update(readFileSync(entry.path)).digest('hex') ===
          entry.backup.digest
        );
      } catch {
        return false;
      }
    },
    dispose() {
      disposed = true;
      entries.clear();
    },
  };
};

/**
 * `POST /api/luoome/import/backup`：为当前上传生成恢复前一致性备份。
 * 备份前后各读一次目标业务摘要；不一致说明期间有写入，拒绝这份备份。
 */
export const createDataImportBackupHandler =
  (options: {
    readonly staging: DataImportStaging;
    readonly backups: DataImportBackupStore;
    readonly targetDigest: () => Promise<string>;
  }) =>
  async (request: Request): Promise<Response> => {
    const transport = await readPluginJson(request);
    if (transport instanceof Response) return transport;
    const parsed = z
      .object({ uploadId: z.string().regex(/^[a-f0-9]{32,64}$/) })
      .strict()
      .safeParse(transport.value);
    if (!parsed.success)
      return noStore(400, {
        ok: false,
        error: { kind: 'invalid_input', message: 'Invalid backup envelope', issues: [] },
      });
    const staged = await options.staging.describe(parsed.data.uploadId);
    if (staged === null)
      return noStore(400, {
        ok: false,
        error: { kind: 'not_found', entity: 'Upload', id: parsed.data.uploadId },
      });
    try {
      const before = await options.targetDigest();
      const backup = await options.backups.create({
        archiveDigest: staged.archiveDigest,
        targetDigest: before,
      });
      const after = await options.targetDigest();
      if (after !== before)
        return noStore(409, {
          ok: false,
          error: {
            kind: 'invalid_input',
            message: '目标在备份期间发生变化，请重新备份',
            issues: [],
          },
        });
      return noStore(200, { ok: true, data: backup });
    } catch (error) {
      return noStore(503, {
        ok: false,
        error: {
          kind: 'internal',
          cause: error instanceof Error ? error.message : 'backup failed',
        },
      });
    }
  };
