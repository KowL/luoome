// dsh-luoome client bundle 构建（M4；plugin 详细设计 §8）。
//
// 产物 dist/client.js = 单文件 CJS + `window.__ModuleLoader__.load({id, factory})` 包装：
// loader 只注册 factory，真正的模块体（CSS/组件）在实例化时执行。`react` / `react/jsx-runtime`
// 保持 external，由 DSH 浏览器平台种子提供同一 React 实例（hooks 才能工作）。
//
// 同时验收构建门槛：原始 bundle ≤ 800 KB、React 未被打进包、包装只出现一次、
// skills 下的文件必须可被服务用户读取（见 assertSkillModes）。
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const CLIENT_BUNDLE_LIMIT_BYTES = 800 * 1024;
export const CLIENT_PLUGIN_ID = 'dsh-luoome';

const root = resolve(import.meta.dir, '..');
const outdir = join(root, 'dist');

// `bun pm pack` **原样保留打包机上的权限**：本地 umask 或编辑器写出的 0600 会被打进
// tarball，装到服务用户下就是 EACCES。DSH 只报 "1 entry did not activate"，profile 路由
// 404——表现为「升级成功但页面打不开」，本地测试全绿（测试用打包者自己的身份跑）。
// 打包前当场拦住，不要等到部署才发现。
const assertSkillModes = async (dir: string): Promise<number> => {
  const offenders: string[] = [];
  let checked = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        const mode = (await stat(full)).mode & 0o777;
        if ((mode & 0o555) !== 0o555)
          offenders.push(`${full.slice(root.length + 1)} dir mode ${mode.toString(8)}`);
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      checked += 1;
      const mode = (await stat(full)).mode & 0o777;
      if ((mode & 0o444) !== 0o444)
        offenders.push(`${full.slice(root.length + 1)} mode ${mode.toString(8)}`);
    }
  };
  await walk(dir);
  if (offenders.length > 0)
    throw new Error(
      `skills must be world-readable before packing (bun pm pack preserves packer modes):\n  ${offenders.join('\n  ')}\nfix: chmod -R u+rwX,go+rX packages/dsh-luoome/skills`,
    );
  return checked;
};

const skillFilesChecked = await assertSkillModes(join(root, 'skills'));

const build = await Bun.build({
  entrypoints: [join(root, 'src/client/index.js')],
  target: 'browser',
  format: 'cjs',
  external: ['react', 'react/jsx-runtime'],
});
if (!build.success) throw new AggregateError(build.logs, 'dsh-luoome client build failed');
const first = build.outputs[0];
if (first === undefined) throw new Error('dsh-luoome client build produced no output');
const code = await first.text();
const wrapperPrefix = `window.__ModuleLoader__.load({id:"${CLIENT_PLUGIN_ID}",factory:(require)=>{`;
const wrapped = `${wrapperPrefix}var module={exports:{}};var exports=module.exports;${code};return module.exports;}});\n`;
if ((wrapped.match(/__ModuleLoader__\.load\(/g) ?? []).length !== 1)
  throw new Error('client bundle must register exactly one __ModuleLoader__ factory');
if (!/require\("react("|\/jsx-runtime")\)/.test(code))
  throw new Error('client bundle must keep react external');
if (/react\.development\.js|__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED/.test(code))
  throw new Error('client bundle must not inline React internals');

await mkdir(outdir, { recursive: true });
const target = join(outdir, 'client.js');
await writeFile(target, wrapped);
const bytes = (await stat(target)).size;
if (bytes > CLIENT_BUNDLE_LIMIT_BYTES)
  throw new Error(
    `client bundle exceeds ${String(CLIENT_BUNDLE_LIMIT_BYTES)} bytes: ${String(bytes)}`,
  );
process.stdout.write(
  `${JSON.stringify({
    clientBundle: 'packages/dsh-luoome/dist/client.js',
    bytes,
    limitBytes: CLIENT_BUNDLE_LIMIT_BYTES,
    reactExternal: true,
    loaderWrapped: true,
    skillFilesChecked,
  })}\n`,
);
