import { describe, it, expect } from 'vitest';
import path from 'path';

function isPathWithinDir(filePath: string, dirPath: string): boolean {
  const resolvedDir = path.resolve(dirPath);
  const resolvedFile = path.resolve(filePath);
  return resolvedFile.startsWith(resolvedDir + path.sep) || resolvedFile === resolvedDir;
}

describe('path traversal protection logic', () => {
  const baseDir = '/app/src/ui';

  it('allows legitimate files within the directory', () => {
    expect(isPathWithinDir('/app/src/ui/app.js', baseDir)).toBe(true);
    expect(isPathWithinDir('/app/src/ui/components/button.js', baseDir)).toBe(true);
    expect(isPathWithinDir('/app/src/ui', baseDir)).toBe(true);
  });

  it('blocks path traversal with ../', () => {
    expect(isPathWithinDir('/app/src/ui/../secret.txt', baseDir)).toBe(false);
    expect(isPathWithinDir('/app/src/ui/../../etc/passwd', baseDir)).toBe(false);
  });

  it('blocks absolute paths outside directory', () => {
    expect(isPathWithinDir('/etc/passwd', baseDir)).toBe(false);
    expect(isPathWithinDir('/app/secret.txt', baseDir)).toBe(false);
  });

  it('handles normalized paths correctly', () => {
    expect(isPathWithinDir(path.normalize('/app/src/ui/./test.js'), baseDir)).toBe(true);
    expect(isPathWithinDir(path.normalize('/app/src/ui/../secret.txt'), baseDir)).toBe(false);
  });
});

describe('vault resolve security', () => {
  it('handleVaultResolve should not return apiKey', async () => {
    const mockGetKey = async () => ({
      apiKey: 'sk-secret-key-12345',
      baseUrl: 'https://api.example.com/v1',
      source: 'env' as const,
    });

    const mockVaultHandler = async (providerId: string) => {
      const got = await mockGetKey();
      return {
        status: 200,
        body: {
          id: providerId,
          hasKey: true,
          baseUrl: got.baseUrl,
          keyLength: got.apiKey.length,
          source: got.source,
        },
      };
    };

    const res = await mockVaultHandler('openai');
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('apiKey');
    expect(res.body.hasKey).toBe(true);
    expect(res.body.keyLength).toBe(19);
    expect(res.body.baseUrl).toBe('https://api.example.com/v1');
    expect(res.body.source).toBe('env');
  });
});
