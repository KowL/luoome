const entries = [
  ['packages/dsh-bridge/src/plugin.ts', 'packages/dsh-bridge/dist'],
  ['apps/agent-runtime/src/index.ts', 'apps/agent-runtime/dist'],
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
