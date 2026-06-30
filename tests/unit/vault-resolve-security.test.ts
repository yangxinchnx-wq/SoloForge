import { describe, it, expect, vi, beforeEach } from 'vitest';
const { mockApiKeyVault } = vi.hoisted(() => ({ mockApiKeyVault: { getKey: vi.fn() } }));
import { handleVaultResolve } from '../../src/security/vaultHandler';

vi.mock('../../src/security/apiKeyVault', () => ({
  apiKeyVault: mockApiKeyVault,
}));

describe('vault resolve', () => {
  beforeEach(() => {
    mockApiKeyVault.getKey.mockReset();
  });

  it('must not return apiKey in HTTP response body', async () => {
    mockApiKeyVault.getKey.mockResolvedValue({
      apiKey: 'sk-secret-key-should-not-leak',
      baseUrl: 'https://api.example.com',
      source: 'env',
    });

    const res = await handleVaultResolve('openai');

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('apiKey');
    expect(res.body).toMatchObject({
      id: 'openai',
      hasKey: true,
      source: 'env',
      keyLength: expect.any(Number),
      baseUrl: 'https://api.example.com',
    });
  });
});
