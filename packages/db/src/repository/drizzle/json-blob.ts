import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * 大块 JSON 的压缩存储前缀；无前缀的行是引入压缩之前的明文存量。
 *
 * 逐股明细、逐信号证据这类 JSON 里同一段表达式/输入结构会被重放上万次，
 * zlib 实测压缩比 30x 以上；压缩只发生在存储层，repository 读出的仍是原始结构。
 */
const BLOB_PREFIX = 'zlib+base64:';

export const encodeJsonBlob = (value: unknown): string =>
  BLOB_PREFIX + gzipSync(JSON.stringify(value), { level: 6 }).toString('base64');

export const decodeJsonBlob = (stored: string): unknown => {
  const payload = stored.startsWith(BLOB_PREFIX)
    ? gunzipSync(Buffer.from(stored.slice(BLOB_PREFIX.length), 'base64')).toString('utf8')
    : stored;
  return JSON.parse(payload);
};

export const isEncodedJsonBlob = (stored: string): boolean => stored.startsWith(BLOB_PREFIX);

/** 已是明文时原样返回，用于一次性回退压缩格式的迁移。 */
export const decodeJsonBlobToText = (stored: string): string =>
  isEncodedJsonBlob(stored)
    ? gunzipSync(Buffer.from(stored.slice(BLOB_PREFIX.length), 'base64')).toString('utf8')
    : stored;
