import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  workspaces: string[];
};
const command = process.argv[2];
if (command !== 'typecheck' && command !== 'build') throw new Error('Expected typecheck or build');

const packages = new Set(
  manifest.workspaces.flatMap((pattern) =>
    [...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })].map(dirname),
  ),
);
for (const workspace of [...packages].sort()) {
  if (command === 'build' && workspace === 'apps/agent-runtime') continue;
  const cwd = resolve(root, workspace);
  if (command === 'build' && !(await Bun.file(resolve(cwd, 'src/index.ts')).exists())) continue;
  console.info(`== ${command} ${workspace}`);
  const args =
    command === 'typecheck'
      ? ['bun', 'x', '--no-install', 'tsc', '--noEmit']
      : [
          'bun',
          '--no-env-file',
          'build',
          'src/index.ts',
          '--outdir',
          'dist',
          '--target',
          'bun',
          '--packages',
          'external',
        ];
  const status = await Bun.spawn(args, { cwd, stdout: 'inherit', stderr: 'inherit' }).exited;
  if (status !== 0) process.exit(status);
}
