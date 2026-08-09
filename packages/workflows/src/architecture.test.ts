import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workflow architecture boundary', () => {
  it('production workflows do not access repositories or adapters directly', () => {
    const root = resolve(import.meta.dirname);
    const files = readdirSync(root).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    for (const file of files) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(source, file).not.toMatch(/ctx\.(repos|adapters)\b/);
    }
  });
});
