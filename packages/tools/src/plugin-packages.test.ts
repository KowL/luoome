import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as analysis from '@luoome/plugin-analysis';
import * as marketTasks from '@luoome/plugin-market-tasks';
import * as notification from '@luoome/plugin-notification';
import * as performanceTask from '@luoome/plugin-performance-task';
import * as report from '@luoome/plugin-report';
import * as strategy from '@luoome/plugin-strategy';
import * as watch from '@luoome/plugin-watch';
import { describe, expect, it } from 'vitest';
import { catalogTools } from './catalog.js';

const root = resolve(import.meta.dirname, '../../..');
interface Workspace {
  name: string;
  directory: string;
  dependencies: Record<string, string>;
}
const workspaces = ['packages', 'packages/plugins', 'apps'].flatMap((parent) =>
  readdirSync(resolve(root, parent), { withFileTypes: true }).flatMap((entry): Workspace[] => {
    const directory = resolve(root, parent, entry.name);
    const manifest = resolve(directory, 'package.json');
    if (!entry.isDirectory() || !existsSync(manifest)) return [];
    const value = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    return [{ name: value.name, directory, dependencies: value.dependencies ?? {} }];
  }),
);
const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
        ? [path]
        : [];
  });

const forbiddenDependency = (from: string, to: string) => {
  if (['@luoome/core', '@luoome/db', '@luoome/adapters'].includes(from))
    return to === '@luoome/toolkit' || to.startsWith('@luoome/plugin-');
  if (from === '@luoome/toolkit')
    return to !== '@luoome/core' && to !== '@luoome/db' && to !== '@luoome/adapters';
  if (from.startsWith('@luoome/plugin-'))
    return !['@luoome/core', '@luoome/toolkit', '@luoome/adapters', '@luoome/db'].includes(to);
  return false;
};

describe('independent plugin packages', () => {
  it('has an acyclic production workspace graph and declared imports across package boundaries', () => {
    const visit = (workspace: Workspace, chain: string[]) => {
      expect(chain, `dependency cycle: ${[...chain, workspace.name].join(' -> ')}`).not.toContain(
        workspace.name,
      );
      for (const name of Object.keys(workspace.dependencies)) {
        const dependency = byName.get(name);
        if (dependency !== undefined) {
          expect(forbiddenDependency(workspace.name, name), `${workspace.name} -> ${name}`).toBe(
            false,
          );
          visit(dependency, [...chain, workspace.name]);
        }
      }
    };
    for (const workspace of workspaces) {
      visit(workspace, []);
      for (const file of sources(resolve(workspace.directory, 'src'))) {
        const text = readFileSync(file, 'utf8');
        const imports = text.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/g);
        for (const [, specifier] of imports) {
          if (specifier === undefined) continue;
          const target = specifier.startsWith('.')
            ? workspaces.find((candidate) =>
                resolve(dirname(file), specifier).startsWith(`${candidate.directory}/`),
              )
            : byName.get(specifier.split('/').slice(0, 2).join('/'));
          if (target === undefined || target.name === workspace.name) continue;
          const label = `${relative(root, file)} -> ${specifier}`;
          expect(workspace.dependencies, label).toHaveProperty(target.name);
          expect(forbiddenDependency(workspace.name, target.name), label).toBe(false);
          if (workspace.name === '@luoome/toolkit' || workspace.name.startsWith('@luoome/plugin-'))
            expect(specifier.startsWith('.'), `cross-package relative import: ${label}`).toBe(
              false,
            );
        }
      }
    }
  });

  it('loads the aggregate entry with Bun from outside the repository without tsconfig aliases', () => {
    const entry = pathToFileURL(resolve(root, 'packages/tools/src/index.ts')).href;
    expect(() =>
      execFileSync('bun', ['--no-env-file', '-e', `await import(${JSON.stringify(entry)})`], {
        cwd: tmpdir(),
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('aggregates the same tool instances from every independent plugin without a second registry', () => {
    for (const plugin of [
      analysis,
      strategy,
      watch,
      report,
      notification,
      performanceTask,
      marketTasks,
    ]) {
      const tools = Object.values(plugin).filter(
        (value) =>
          typeof value === 'object' && value !== null && 'execute' in value && 'name' in value,
      );
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools)
        expect(catalogTools[tool.name as keyof typeof catalogTools]).toBe(tool);
    }
  });
});
