import { describe, expect, it } from 'vitest';

import { applyEnvEntries, parseEnvFile } from './env-file.js';

describe('env-file', () => {
  describe('parseEnvFile', () => {
    it('解析 KEY=value 与 export 前缀', () => {
      expect(parseEnvFile('A=1\nexport B=2\n')).toEqual({ A: '1', B: '2' });
    });

    it('跳过空行与整行注释', () => {
      expect(parseEnvFile('# comment\n\nA=1\n   \n')).toEqual({ A: '1' });
    });

    it('无引号值剥离行内注释（# 前需空白）', () => {
      expect(parseEnvFile('A=1 # note\nB=abc#def\n')).toEqual({ A: '1', B: 'abc#def' });
    });

    it('引号值保留 # 与内部空白', () => {
      expect(parseEnvFile('A="x # y"\nB=\' z \'\n')).toEqual({ A: 'x # y', B: ' z ' });
    });

    it('无 = 或空 key 的行静默跳过', () => {
      expect(parseEnvFile('NOEQ\n=novalue\nA=1\n')).toEqual({ A: '1' });
    });

    it('空值合法（KEY=）', () => {
      expect(parseEnvFile('A=\n')).toEqual({ A: '' });
    });
  });

  describe('applyEnvEntries', () => {
    it('只写入未设置的 key，返回写入清单', () => {
      const target: Record<string, string | undefined> = { EXISTING: 'keep' };
      const applied = applyEnvEntries({ EXISTING: 'override', NEW: 'yes' }, target);
      expect(target.EXISTING).toBe('keep');
      expect(target.NEW).toBe('yes');
      expect(applied).toEqual(['NEW']);
    });
  });
});
