import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REQUIRE_TOKEN = process.env.SOLOFORGE_REQUIRE_TOKENS !== '0';

let validTokens: Set<string> = new Set();
let startupToken: string | null = null;
let tokenFilePath: string | null = null;

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function initAuthToken(appDir: string): string {
  tokenFilePath = path.join(appDir, '.soloforge-token');

  try {
    if (fs.existsSync(tokenFilePath)) {
      const stored = fs.readFileSync(tokenFilePath, 'utf-8').trim();
      if (stored && stored.length >= 32) {
        startupToken = stored;
        validTokens.add(stored);
        return stored;
      }
    }
  } catch {
    // 文件损坏或无权限，重新生成
  }

  startupToken = generateToken();
  validTokens.add(startupToken);

  try {
    fs.writeFileSync(tokenFilePath, startupToken, 'utf-8');
  } catch (err: any) {
    console.warn('[auth] ⚠️ 无法持久化 token 文件:', err.message);
    console.warn('[auth]    token 仅在本次运行期间有效，重启后前端需要重新获取');
  }

  return startupToken;
}

export function getStartupToken(): string | null {
  return startupToken;
}

export function registerValidToken(token: string): void {
  if (token && typeof token === 'string' && token.length > 0) {
    validTokens.add(token);
  }
}

export function revokeToken(token: string): void {
  validTokens.delete(token);
}

export function revokeAllTokens(): void {
  validTokens = new Set();
  if (startupToken) {
    validTokens.add(startupToken);
  }
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }

  const customToken = req.headers['x-soloforge-token'];
  if (typeof customToken === 'string' && customToken.length > 0) {
    return customToken;
  }

  return null;
}

export function authenticateToken(req: Request, res: Response, next: NextFunction): void {
  if (!REQUIRE_TOKEN) {
    return next();
  }

  const token = extractToken(req);

  if (!token) {
    res.status(401).json({
      error: 'Missing authentication token',
      code: 'AUTH_TOKEN_MISSING',
    });
    return;
  }

  if (!validTokens.has(token)) {
    res.status(401).json({
      error: 'Invalid or expired token',
      code: 'AUTH_TOKEN_INVALID',
    });
    return;
  }

  (req as any)._authenticated = true;
  (req as any)._authToken = token;

  next();
}

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  if (!REQUIRE_TOKEN) {
    (req as any)._authenticated = false;
    return next();
  }

  const token = extractToken(req);
  if (token && validTokens.has(token)) {
    (req as any)._authenticated = true;
    (req as any)._authToken = token;
  } else {
    (req as any)._authenticated = false;
  }

  next();
}

export function getActiveTokenCount(): number {
  return validTokens.size;
}
