import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  DATA_IMPORT_VERSION,
  DataImportError,
  type DataImportRow,
  type DataImportScope,
  DataImportScopeSchema,
  type DataImportSnapshot,
  type DataImportStorageSchema,
} from '@luoome/core';
import { DATA_IMPORT_FTS_SHADOW_TABLES, DATA_IMPORT_MANIFEST } from './data-import-manifest.js';
import { assertDataImportRowScope, validateDataImportRow } from './data-transfer-contract.js';

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_DECODED_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 100_000;

export const readDataImportStorageSchema = (db: DatabaseSync): DataImportStorageSchema => {
  const result: Record<string, DataImportStorageSchema[string]> = {};
  for (const name of Object.keys(DATA_IMPORT_MANIFEST).sort()) {
    const columns = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
    if (columns.length === 0) continue;
    const indexes = db
      .prepare(`PRAGMA index_list(${quote(name)})`)
      .all()
      .map((index) => {
        const definition = db
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
          .get(String(index.name));
        return {
          name: String(index.name),
          unique: Boolean(index.unique),
          partial: Boolean(index.partial),
          sql:
            typeof definition?.sql === 'string' ? definition.sql.replace(/\s+/g, ' ').trim() : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    result[name] = {
      columns: columns.map((column) => ({
        name: String(column.name),
        type: String(column.type).toUpperCase(),
        notNull: Boolean(column.notnull),
        primaryKey: Number(column.pk),
        hidden: Number(column.hidden),
      })),
      indexes,
    };
  }
  return result;
};

export const readSqliteImportSnapshot = (
  path: string,
  rawScope: DataImportScope,
  expectedSchema: DataImportStorageSchema,
): DataImportSnapshot => {
  const scope = DataImportScopeSchema.parse(rawScope);
  for (const suffix of ['-wal', '-journal']) {
    if (existsSync(`${path}${suffix}`) && statSync(`${path}${suffix}`).size > 0)
      throw new DataImportError('format', '输入必须是独立一致性快照，不能附带非空 WAL 或 journal');
  }
  const initialStat = statSync(path);
  const size = initialStat.size;
  if (size < 16 || size > MAX_FILE_BYTES)
    throw new DataImportError('limit', '文件大小超出导入范围');
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  try {
    const header = Buffer.alloc(16);
    if (readSync(fd, header, 0, 16, 0) !== 16 || header.toString('ascii') !== 'SQLite format 3\0')
      throw new DataImportError('format', '仅支持 SQLite 二进制快照；不支持 SQL 脚本');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (count === 0) throw new DataImportError('format', '读取快照时文件已变化');
      hash.update(buffer.subarray(0, count));
      position += count;
    }
  } finally {
    closeSync(fd);
  }
  const archiveDigest = hash.digest('hex');
  let db: DatabaseSync | undefined;
  try {
    const uri = pathToFileURL(path);
    uri.searchParams.set('mode', 'ro');
    uri.searchParams.set('immutable', '1');
    db = new DatabaseSync(uri.toString(), { readOnly: true, allowExtension: false });
    db.exec('BEGIN');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      throw new DataImportError('format', 'SQLite 完整性校验失败');
    const objects = db.prepare('SELECT name, type, sql FROM sqlite_schema').all();
    const tableTypes = new Map(
      db
        .prepare('PRAGMA table_list')
        .all()
        .filter((row) => row.schema === 'main')
        .map((row) => [String(row.name), String(row.type)]),
    );
    const fts = objects.find((object) => object.name === 'research_document_fts');
    const validFts =
      tableTypes.get('research_document_fts') === 'virtual' &&
      /\bUSING\s+fts5\s*\(/i.test(String(fts?.sql));
    for (const object of objects) {
      const name = String(object.name);
      if (name.startsWith('sqlite_')) continue;
      if (object.type === 'trigger' || object.type === 'view')
        throw new DataImportError('schema', '快照包含不支持的触发器或视图');
      if (object.type !== 'table') continue;
      if (DATA_IMPORT_FTS_SHADOW_TABLES.has(name)) {
        if (!validFts || tableTypes.get(name) !== 'shadow')
          throw new DataImportError('schema', '孤立或伪装的 FTS shadow 表');
        continue;
      }
      if (!Object.hasOwn(DATA_IMPORT_MANIFEST, name))
        throw new DataImportError('schema', `未声明的表: ${name}`);
      if (
        /CREATE\s+VIRTUAL\s+TABLE/i.test(String(object.sql)) &&
        (name !== 'research_document_fts' || !validFts)
      )
        throw new DataImportError('schema', '快照包含不支持的虚表');
    }
    const schema = readDataImportStorageSchema(db);
    for (const [name, policy] of Object.entries(DATA_IMPORT_MANIFEST)) {
      if (policy === 'preserve' || policy === 'transient' || policy === 'rebuild') continue;
      if (!expectedSchema[name] || digest(schema[name]) !== digest(expectedSchema[name]))
        throw new DataImportError('schema', `表结构不是当前支持版本: ${name}`);
    }
    const tables: Record<string, DataImportRow[]> = {};
    const ignoredCounts: Record<string, number> = {};
    let totalRows = 0;
    let decodedBytes = 0;
    for (const [name, policy] of Object.entries(DATA_IMPORT_MANIFEST)) {
      if (schema[name] === undefined) continue;
      if (policy === 'preserve' || policy === 'transient' || policy === 'rebuild') {
        ignoredCounts[name] = Number(
          db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get()?.n,
        );
        if (
          policy === 'transient' &&
          name !== 'watchlist_import_previews' &&
          ignoredCounts[name] !== 0
        )
          throw new DataImportError('busy', `来源有执行控制状态: ${name}`);
        continue;
      }
      tables[name] = [];
      for (const stored of db.prepare(`SELECT * FROM ${quote(name)}`).iterate()) {
        totalRows += 1;
        if (totalRows > MAX_ROWS) throw new DataImportError('limit', '快照行数超出当前校验容量');
        for (const value of Object.values(stored)) {
          if (
            value !== null &&
            typeof value !== 'string' &&
            !(typeof value === 'number' && Number.isFinite(value))
          )
            throw new DataImportError('schema', '快照包含不支持的存储值');
        }
        const row = stored as DataImportRow;
        decodedBytes += Buffer.byteLength(JSON.stringify(row));
        if (decodedBytes > MAX_DECODED_BYTES)
          throw new DataImportError('limit', '快照解码内容超出当前校验容量');
        assertDataImportRowScope(name, row, scope);
        try {
          // domain 表走领域校验；structural 表只钉存储形态，级别由 preview/回执披露。
          validateDataImportRow(name, row);
        } catch (error) {
          if (error instanceof DataImportError) throw error;
          throw new DataImportError(
            'schema',
            `表 ${name} 校验失败: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        tables[name]?.push(row);
      }
    }
    if (tables.accounts?.length !== 1)
      throw new DataImportError('scope', '快照必须包含唯一 owner 账户');
    const verify = createHash('sha256');
    const verifyFd = openSync(path, 'r');
    try {
      const chunk = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < size) {
        const n = readSync(verifyFd, chunk, 0, Math.min(chunk.length, size - offset), offset);
        if (n === 0) throw new DataImportError('format', '快照读取期间发生变化');
        verify.update(chunk.subarray(0, n));
        offset += n;
      }
    } finally {
      closeSync(verifyFd);
    }
    const finalStat = statSync(path);
    if (
      initialStat.ino !== finalStat.ino ||
      initialStat.dev !== finalStat.dev ||
      size !== finalStat.size ||
      initialStat.mtimeMs !== finalStat.mtimeMs ||
      archiveDigest !== verify.digest('hex')
    )
      throw new DataImportError('format', '快照读取期间发生变化，暂存文件必须封存且无writer');
    db.exec('COMMIT');
    return {
      format: 'sqlite',
      manifestVersion: DATA_IMPORT_VERSION,
      archiveDigest,
      tables,
      ignoredCounts,
      schema,
    };
  } catch (error) {
    if (db?.isTransaction) db.exec('ROLLBACK');
    if (error instanceof DataImportError) throw error;
    throw new DataImportError('format', 'SQLite 快照读取或领域校验失败');
  } finally {
    db?.close();
  }
};
