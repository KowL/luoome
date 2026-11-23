import { expect, it } from 'bun:test';
import {
  loadDshDevelopmentConfig,
  loadDshModelBudgetPolicy,
  loadDshRolloutPolicy,
  loadDshSessionRetentionPolicy,
} from './config.js';

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

it('会话目录保留策略默认关闭且只接受保守参数', () => {
  expect(loadDshSessionRetentionPolicy({})).toEqual({ mode: 'off', retentionDays: 30 });
  expect(
    loadDshSessionRetentionPolicy({
      LUOOME_DSH_SESSION_GC: 'dry-run',
      LUOOME_DSH_SESSION_RETENTION_DAYS: '90',
    }),
  ).toEqual({ mode: 'dry-run', retentionDays: 90 });
  expect(() => loadDshSessionRetentionPolicy({ LUOOME_DSH_SESSION_GC: 'delete' })).toThrow();
  expect(() => loadDshSessionRetentionPolicy({ LUOOME_DSH_SESSION_RETENTION_DAYS: '0' })).toThrow();
});

it('模型预算默认不计量，显式配置后才启用', () => {
  expect(loadDshModelBudgetPolicy({})).toBeUndefined();
  expect(
    loadDshModelBudgetPolicy({
      LUOOME_DSH_MODEL_BUDGET_TOKENS: '8000',
      LUOOME_DSH_MODEL_BUDGET_REQUESTS: '12',
      LUOOME_DSH_MODEL_BUDGET_WINDOW_HOURS: '6',
    }),
  ).toEqual({ maxTokens: 8000, maxRequests: 12, windowMs: 21_600_000 });
  expect(() => loadDshModelBudgetPolicy({ LUOOME_DSH_MODEL_BUDGET_TOKENS: '0' })).toThrow();
});

it('灰度默认全量放行，可用开关、百分比与 allowlist 收窄', () => {
  expect(loadDshRolloutPolicy({})).toEqual({ enabled: true, percent: 100, accountAllowlist: [] });
  expect(
    loadDshRolloutPolicy({
      LUOOME_DSH_ROLLOUT: 'off',
      LUOOME_DSH_ROLLOUT_PERCENT: '25',
      LUOOME_DSH_ROLLOUT_ACCOUNTS: 'vip, other',
    }),
  ).toEqual({ enabled: false, percent: 25, accountAllowlist: ['vip', 'other'] });
  expect(() => loadDshRolloutPolicy({ LUOOME_DSH_ROLLOUT_PERCENT: '101' })).toThrow();
});
