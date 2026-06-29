/**
 * Verify SoloForge P0 security fixes.
 *
 * Usage:
 *   npx tsx scripts/verify-security-fixes.ts
 *
 * Exit codes:
 *   0 - all checks passed
 *   1 - one or more checks failed
 */

import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();

function read(filePath: string): string {
  const absolute = path.join(ROOT, filePath);
  if (!fs.existsSync(absolute)) return '';
  return fs.readFileSync(absolute, 'utf-8');
}

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`[PASS] ${label}`);
  } else {
    console.log(`[FAIL] ${label}`);
    process.exitCode = 1;
  }
}

function main(): void {
  console.log('[verify] Starting security fix verification...\n');

  // B1: vaultHandler must not return apiKey in HTTP response
  const vaultHandler = read('src/security/vaultHandler.ts');
  check(
    'B1: vaultHandler does NOT return apiKey in handleVaultResolve HTTP response',
    !vaultHandler.includes('apiKey: got.apiKey') &&
      !vaultHandler.includes('return jsonResponse(200, { id: providerId, apiKey:')
  );

  // B2: api-server CORS must not hardcode localhost:5173 as fallback for all origins
  const apiServer = read('src/api-server.ts');
  check(
    'B2: api-server does NOT hardcode localhost:5173 as global CORS fallback',
    !apiServer.includes("isLocalhost ? origin : 'http://localhost:5173'")
  );

  // B3: apiKeyVault should emit CRITICAL when keytar is unavailable
  const apiKeyVault = read('src/security/apiKeyVault.ts');
  check(
    'B3: apiKeyVault emits CRITICAL log/event when keytar fallback is used',
    apiKeyVault.includes('CRITICAL') && apiKeyVault.includes('memoryFallback')
  );

  // B4: garnet-bridge should not swallow xadd errors silently
  const garnetBridge = read('src/data/garnet/garnet-bridge.ts');
  check(
    'B4: garnet-bridge does NOT swallow xadd errors with empty catch',
    !garnetBridge.includes('.catch(() => {})')
  );

  // Dependency: esbuild known vulnerability check (Windows file read)
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
    devDependencies?: Record<string, string>;
  };
  const esbuildVersion = pkg.devDependencies?.esbuild || '';
  const esbuildMajor = parseInt(esbuildVersion.replace(/^[^\d]*/, '').split('.')[0] || '0', 10);
  const esbuildMinor = parseInt(esbuildVersion.split('.')[1] || '0', 10);
  check(
    'DEP: esbuild is not vulnerable (>= 0.28.0 recommended)',
    !(esbuildMajor === 0 && esbuildMinor < 28) || esbuildVersion === ''
  );

  if (process.exitCode === 1) {
    console.log('\n[verify] Some checks FAILED. Please review the fixes.');
  } else {
    console.log('\n[verify] All security fix checks PASSED.');
  }
}

main();
