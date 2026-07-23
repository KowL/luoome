import { describe, expect, it } from 'vitest';

import {
  ALL_LLM_PROVIDERS,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  LLM_CALL_TIMEOUT_MS,
  LLM_MAX_PROMPT_TOKENS,
  LLMProviderConfigSchema,
  LLMProviderNameSchema,
  parseLlmProviderConfigFromEnv,
} from './llm-provider.js';

describe('entity/llm-provider', () => {
  describe('LLMProviderNameSchema', () => {
    it('accepts all 3 providers', () => {
      for (const p of ALL_LLM_PROVIDERS) {
        expect(LLMProviderNameSchema.parse(p)).toBe(p);
      }
    });

    it('rejects unknown provider', () => {
      expect(() => LLMProviderNameSchema.parse('grok')).toThrow();
    });
  });

  describe('defaults', () => {
    it('DEFAULT_LLM_BASE_URL has entries for every provider', () => {
      for (const p of ALL_LLM_PROVIDERS) {
        expect(p in DEFAULT_LLM_BASE_URL).toBe(true);
      }
    });

    it('DEFAULT_LLM_MODEL has non-empty value for every provider', () => {
      for (const p of ALL_LLM_PROVIDERS) {
        expect(DEFAULT_LLM_MODEL[p].length).toBeGreaterThan(0);
      }
    });

    it('token / timeout constants positive', () => {
      expect(LLM_MAX_PROMPT_TOKENS).toBeGreaterThan(0);
      expect(LLM_CALL_TIMEOUT_MS).toBeGreaterThan(0);
    });
  });

  describe('LLMProviderConfigSchema', () => {
    it('accepts full openai-compatible config', () => {
      const cfg = LLMProviderConfigSchema.parse({
        provider: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
      });
      expect(cfg.provider).toBe('openai-compatible');
    });

    it('rejects bad baseUrl', () => {
      expect(() =>
        LLMProviderConfigSchema.parse({
          provider: 'openai-compatible',
          baseUrl: 'not-a-url',
          apiKey: 'sk',
          model: 'm',
        }),
      ).toThrow();
    });

    it('rejects empty apiKey', () => {
      expect(() =>
        LLMProviderConfigSchema.parse({
          provider: 'openai-compatible',
          apiKey: '',
          model: 'm',
        }),
      ).toThrow();
    });
  });

  describe('parseLlmProviderConfigFromEnv', () => {
    it('requires LUOOME_LLM_PROVIDER', () => {
      expect(() => parseLlmProviderConfigFromEnv({})).toThrow(/LLM_PROVIDER/);
      expect(() => parseLlmProviderConfigFromEnv({ LUOOME_LLM_PROVIDER: '  ' })).toThrow(
        /LLM_PROVIDER/,
      );
    });

    it('rejects removed mock provider', () => {
      expect(() => parseLlmProviderConfigFromEnv({ LUOOME_LLM_PROVIDER: 'mock' })).toThrow(
        /openai-compatible/,
      );
    });

    it('throws when real provider configured without apiKey', () => {
      expect(() =>
        parseLlmProviderConfigFromEnv({ LUOOME_LLM_PROVIDER: 'openai-compatible' }),
      ).toThrow(/API_KEY/);
      expect(() =>
        parseLlmProviderConfigFromEnv({ LUOOME_LLM_PROVIDER: 'anthropic', LUOOME_LLM_API_KEY: '' }),
      ).toThrow(/API_KEY/);
    });

    it('parses openai-compatible with all fields', () => {
      const cfg = parseLlmProviderConfigFromEnv({
        LUOOME_LLM_PROVIDER: 'openai-compatible',
        LUOOME_LLM_BASE_URL: 'https://api.deepseek.com/v1',
        LUOOME_LLM_API_KEY: 'sk-test',
        LUOOME_LLM_MODEL: 'deepseek-chat',
      });
      expect(cfg).toEqual({
        provider: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
      });
    });

    it('falls back to default model / baseUrl when env not set', () => {
      const cfg = parseLlmProviderConfigFromEnv({
        LUOOME_LLM_PROVIDER: 'anthropic',
        LUOOME_LLM_API_KEY: 'sk-ant',
      });
      expect(cfg.provider).toBe('anthropic');
      expect(cfg.model).toBe(DEFAULT_LLM_MODEL.anthropic);
      expect(cfg.baseUrl).toBeUndefined();
    });

    it('throws on unknown provider string', () => {
      expect(() =>
        parseLlmProviderConfigFromEnv({
          LUOOME_LLM_PROVIDER: 'grok',
          LUOOME_LLM_API_KEY: 'x',
        }),
      ).toThrow(/非法/);
    });
  });
});
