import { z } from 'zod';

/**
 * Tushare 官方 HTTP API envelope（https://tushare.pro/document/1?doc_id=130）。
 *
 * 所有接口共用唯一协议 `{code, msg, data: {fields, items}}`：行是数组，列名在 fields 里，
 * 必须按 fields 动态映射成对象，不能用固定 Zod schema 直接 parse 每行。
 * 不为对象数组或无字段名的纯数组增加宽松兼容。
 */

const TushareEnvelopeSchema = z.object({
  code: z.number().int(),
  msg: z.string().nullish().default(''),
  data: z.object({
    fields: z.array(z.string()),
    items: z.array(z.array(z.unknown())),
  }),
});

/** envelope → 行对象数组；code≠0 或行列数不符时抛错。 */
export const parseTushareEnvelopeRows = (raw: unknown): Array<Record<string, unknown>> => {
  const env = TushareEnvelopeSchema.parse(raw);
  if (env.code !== 0) {
    throw new Error(`tushare upstream_error: ${env.code} ${env.msg ?? ''}`);
  }
  return env.data.items.map((row) => {
    if (row.length !== env.data.fields.length) {
      throw new Error('tushare parse: fields/items length mismatch');
    }
    const obj: Record<string, unknown> = {};
    env.data.fields.forEach((field, i) => {
      obj[field] = row[i];
    });
    return obj;
  });
};
