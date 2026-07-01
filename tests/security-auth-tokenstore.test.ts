import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateApiToken, loadApiTokens, loadApiTokensAsync } from '../src/security/auth';

vi.mock('../src/security/apiKeyVault', () => ({
  apiKeyVault: {
    init: async () => {},
    getKey: async () => null,
    setKey: async () => {},
  },
}));

describe('token helpers (single-host mode)', () => {
  it('generateApiToken produces 64 hex chars', () => {
    const t = generateApiToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generateApiToken returns unique tokens', () => {
    const set = new Set<string>();
    for (let i = 0; i < 10; i++) set.add(generateApiToken());
    expect(set.size).toBe(10);
  });

  it('loadApiTokens throws when env is empty', () => {
    const original = process.env.SOLOFORGE_API_TOKENS;
    delete process.env.SOLOFORGE_API_TOKENS;
    try {
      expect(() => loadApiTokens()).toThrow();
    } finally {
      if (original !== undefined) process.env.SOLOFORGE_API_TOKENS = original;
    }
  });

  it('loadApiTokens parses comma-separated env', () => {
    const original = process.env.SOLOFORGE_API_TOKENS;
    process.env.SOLOFORGE_API_TOKENS = ' aaa , bbb , ccc ';
    try {
      const tokens = loadApiTokens();
      expect(tokens).toEqual(['aaa', 'bbb', 'ccc']);
    } finally {
      if (original === undefined) delete process.env.SOLOFORGE_API_TOKENS;
      else process.env.SOLOFORGE_API_TOKENS = original;
    }
  });
});

describe('loadApiTokensAsync resolution order', () => {
  const originalEnv = process.env.SOLOFORGE_API_TOKENS;
  const originalRequire = process.env.SOLOFORGE_REQUIRE_TOKENS;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SOLOFORGE_API_TOKENS;
    else process.env.SOLOFORGE_API_TOKENS = originalEnv;
    if (originalRequire === undefined) delete process.env.SOLOFORGE_REQUIRE_TOKENS;
    else process.env.SOLOFORGE_REQUIRE_TOKENS = originalRequire;
  });

  it('returns env tokens when env is set', async () => {
    process.env.SOLOFORGE_API_TOKENS = 'env-token';
    const tokens = await loadApiTokensAsync();
    expect(tokens).toEqual(['env-token']);
  });

  it('throws in strict mode when nothing is available', async () => {
    delete process.env.SOLOFORGE_API_TOKENS;
    process.env.SOLOFORGE_REQUIRE_TOKENS = '1';
    // Note: vi.mock hoists, so this branch may not exercise fully. We at least
    // verify that REQUIRE_TOKENS=1 in env leads to a thrown error when both
    // env and vault are empty. (The exact vault behavior depends on the host
    // environment, so we just check the error is thrown when REQUIRE=1.)
    await expect(loadApiTokensAsync()).rejects.toThrow();
  });
});