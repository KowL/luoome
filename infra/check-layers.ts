import { readFile } from 'node:fs/promises';

const domain = new Set([
  'core',
  'db',
  'tools',
  'workflows',
  'batch',
  'mcp',
  'adapters',
  'cli',
  'tui',
]);
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
    if (root === 'packages' && domain.has(workspace ?? '') && sdk)
      failures.push(`${path}: forbidden AI dependency ${target}`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log('AI dependency boundaries verified');
