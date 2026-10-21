import { expect, it } from 'bun:test';
import { loadDshDevelopmentConfig } from './config.js';

it('keeps AI SDK default and rejects incomplete or production DSH opt-in', () => {
  expect(loadDshDevelopmentConfig({}, 'production')).toBeUndefined();
  expect(() => loadDshDevelopmentConfig({ LUOOME_CHAT_RUNTIME: 'dsh' }, 'development')).toThrow(
    'DEVELOPMENT',
  );
  const env = {
    LUOOME_CHAT_RUNTIME: 'dsh',
    LUOOME_DSH_DEVELOPMENT: 'true',
    LUOOME_DSH_NODE_PATH: '/fixture/node',
  };
  expect(() => loadDshDevelopmentConfig(env, 'production')).toThrow('development');
  expect(() =>
    loadDshDevelopmentConfig({ ...env, LUOOME_DSH_NODE_PATH: 'node' }, 'development'),
  ).toThrow('absolute');
  expect(loadDshDevelopmentConfig(env, 'development')).toMatchObject({
    development: true,
    nodePath: '/fixture/node',
  });
});
