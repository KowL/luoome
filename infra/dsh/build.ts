import { mkdir, writeFile } from 'node:fs/promises';

const entries = [
  ['packages/dsh-bridge/src/standalone-panels.ts', 'packages/dsh-bridge/dist/panels'],
  ['packages/dsh-bridge/src/standalone-prompt.ts', 'packages/dsh-bridge/dist'],
] as const;
for (const [entrypoint, outdir] of entries) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: 'node',
    format: 'esm',
    external: ['@deepseek-ai/*'],
  });
  if (!result.success) throw new AggregateError(result.logs, `DSH build failed: ${entrypoint}`);
  console.log(`Built ${entrypoint} for Node`);
}

const panelDir = 'packages/dsh-bridge/dist/panels';
const client = await Bun.build({
  entrypoints: ['packages/dsh-bridge/src/standalone-panels-client.js'],
  target: 'browser',
  format: 'cjs',
  external: ['react'],
});
if (!client.success) throw new AggregateError(client.logs, 'Panel client build failed');
await mkdir(panelDir, { recursive: true });
await writeFile(
  `${panelDir}/client.js`,
  `window.__ModuleLoader__.load({id:"@luoome/dsh-panels",factory:(require)=>{var module={exports:{}};var exports=module.exports;${await client.outputs[0].text()};return module.exports;}});`,
);
await writeFile(
  `${panelDir}/package.json`,
  JSON.stringify({
    name: '@luoome/dsh-panels',
    version: '0.1.0',
    type: 'module',
    exports: { '.': './standalone-panels.js', './client': './client.js' },
    dsh: {
      client: {
        platform: 'web',
        inject: ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar'],
      },
    },
  }),
);
