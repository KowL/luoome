/**
 * 项目 .env 文件解析（纯函数，core 不触 fs）。
 *
 * 背景：LLM / 行情等 provider 配置原本只走环境变量（parseLlmProviderConfigFromEnv
 * 等）。为支持「配置写在项目 .env 文件」，各 surface（CLI/Web）启动时读取
 * .env 文件并调用 applyEnvEntries 注入 process.env（仅填未设置的 key，
 * 真实环境变量永远优先）。
 *
 * 文件读取在各 surface（packages/cli/src/env.ts、apps/web/src/env.ts），
 * core 只提供解析与应用两个纯函数。
 */

/**
 * 解析 .env 文件内容为 key-value 映射。
 *
 * 支持的行格式（对齐 dotenv 常用子集，刻意保持最小）：
 * - `KEY=value` / `export KEY=value`（export 前缀可选）
 * - 值可加双引号或单引号（引号内 # 不视为注释；不处理转义序列）
 * - 无引号值的行内注释：`KEY=value # comment`（# 前需有空白）
 * - 整行注释 `# ...` 与空行跳过
 * - 无 `=` 或 key 为空的行静默跳过
 */
export const parseEnvFile = (content: string): Record<string, string> => {
  const entries: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (key === '') continue;
    let value = body.slice(eq + 1).trim();
    const first = value.charAt(0);
    if ((first === '"' || first === "'") && value.endsWith(first) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // 无引号：剥离行内注释（# 前必须是空白，避免误伤值内的 #）
      const commentIdx = value.search(/\s#/);
      if (commentIdx >= 0) value = value.slice(0, commentIdx).trimEnd();
    }
    entries[key] = value;
  }
  return entries;
};

/**
 * 把解析结果注入目标 env 对象（通常 process.env）。
 * 仅写入**尚未设置**的 key——真实环境变量优先于 .env 文件。
 * 返回实际写入的 key 列表（便于调用方 debug 日志）。
 */
export const applyEnvEntries = (
  entries: Readonly<Record<string, string>>,
  target: Record<string, string | undefined>,
): readonly string[] => {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (target[key] === undefined) {
      target[key] = value;
      applied.push(key);
    }
  }
  return applied;
};
