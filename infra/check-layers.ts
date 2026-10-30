import { readFile } from 'node:fs/promises';

const domain = new Set(['core', 'db', 'tools', 'workflows', 'batch', 'adapters', 'cli', 'tui']);

/**
 * 领域层不发起模型请求（REQ-M1-07）。import 检查只挡包依赖，挡不住行为：
 * 一个只 import `node:fs` 的适配器照样能 POST 到模型供应商，所以这些包另外扫
 * 模型 endpoint 字面量。语义与理由见 docs/ARCHITECTURE.md「模型运行时边界」。
 */
const modelBoundary = new Set(['core', 'db', 'tools', 'workflows', 'adapters', 'batch']);
const modelEndpointLiterals = ['/chat/completions', '/completions', '/embeddings'];

/**
 * 唯一白名单：研究库向量化。它把检索文本编码成向量写进本地研究库索引，不产出判断、
 * 不写 Advice、不进入 tool/workflow 决策，且默认关闭（缺 `LUOOME_RESEARCH_EMBEDDING_ENABLED`
 * 就不装配）。等 DSH 侧提供 embedding 供应商后，删除该目录并同时删掉这条白名单。
 */
const modelEndpointAllowlist = ['packages/adapters/src/research-embedding/'];

const failures: string[] = [];
for await (const path of new Bun.Glob('{packages,apps}/**/*.{ts,tsx,js,mjs}').scan('.')) {
  if (path.split('/').some((part) => part === 'node_modules' || part === 'dist')) continue;
  const [root, workspace] = path.split('/');
  const source = await readFile(path, 'utf8');
  for (const match of source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g,
  )) {
    const target = match[1] ?? '';
    const sdk =
      target === 'ai' || target.startsWith('@ai-sdk/') || target.startsWith('@deepseek-ai/');
    /**
     * 暴露面判定归位（M2-09 / T12）：`packages/tools/src/exposure/` 是插件面（旧 MCP 面已随
     * M2-03 删除）的唯一判定层，只允许纯数据契约。它一旦 import 了 DSH 宿主类型，换 surface
     * 时判定就会被一起带走 —— 所以这条单独报，名字和理由都点名 M2-09，而不是混进通用 AI 依赖里。
     */
    if (root === 'packages' && workspace === 'tools' && target.startsWith('@deepseek-ai/'))
      failures.push(
        `${path}: packages/tools must stay DSH-free, imports ${target} (M2-09 exposure boundary)`,
      );
    else if (root === 'packages' && domain.has(workspace ?? '') && sdk)
      failures.push(`${path}: forbidden AI dependency ${target}`);
  }
  if (
    root !== 'packages' ||
    !modelBoundary.has(workspace ?? '') ||
    modelEndpointAllowlist.some((allowed) => path.startsWith(allowed))
  )
    continue;
  const hits = modelEndpointLiterals.filter((literal) => source.includes(literal));
  // `/chat/completions` 已命中时不再重复报 `/completions`，一处命中只算一个失败项。
  const reported = hits.includes('/chat/completions')
    ? hits.filter((literal) => literal !== '/completions')
    : hits;
  for (const literal of reported)
    failures.push(`${path}: forbidden model endpoint literal ${literal} (领域层不发起模型请求)`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log('AI dependency and model endpoint boundaries verified');
