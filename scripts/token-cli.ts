/**
 * scripts/token-cli.ts — 统一 token 管理 CLI
 *
 * 用法:
 *   tsx scripts/token-cli.ts init           # 首次初始化 (创建第一个 active token)
 *   tsx scripts/token-cli.ts rotate         # 主动触发轮换 (新 active, 旧进入 rotating)
 *   tsx scripts/token-cli.ts revoke <kid>   # 吊销指定 kid (不影响其他)
 *   tsx scripts/token-cli.ts revoke-family <familyId> [--reason=reuse_detected|manual|expired]
 *   tsx scripts/token-cli.ts list           # 列出所有 token (脱敏, kid + status + family)
 *   tsx scripts/token-cli.ts show <kid>     # 打印指定 kid 明文 token (仅在控制台)
 *
 * 输出:
 *   - 总是打印 JSON 一行 (方便脚本消费)
 *   - init/rotate 会输出明文 token, 警告用户妥善保存
 *
 * 环境要求:
 *   - 必须能访问 ApiKeyVault (走 OS 钥匙串)
 *   - 测试时设 SOLOFORGE_USER_DATA=./data/test-userdata 可隔离
 */

import { logger } from '../src/core/logger';
import {
  tokenStoreInit,
  createToken,
  listActiveKids,
  findByKid,
  revokeToken,
  revokeFamily,
  type FamilyRevokeReason,
} from '../src/security/tokenStore';

const VALID_REASONS: FamilyRevokeReason[] = ['reuse_detected', 'manual', 'expired'];

function printJson(obj: any): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function parseArgs(argv: string[]): { cmd: string; rest: string[]; flags: Map<string, string> } {
  const [cmd = '', ...rest] = argv;
  const flags = new Map<string, string>();
  for (const arg of rest) {
    if (arg.startsWith('--')) {
      const [k, v] = arg.slice(2).split('=');
      flags.set(k, v ?? 'true');
    }
  }
  return { cmd, rest, flags };
}

function shortStatus(kid: string, status: string, family: string, exp: number): string {
  return `${kid}  status=${status.padEnd(9)}  family=${family}  expiresAt=${new Date(exp).toISOString()}`;
}

async function cmdInit(): Promise<number> {
  await tokenStoreInit();
  const existing = await listActiveKids();
  const activeCount = existing.filter((e) => e.status === 'active').length;
  if (activeCount > 0) {
    printJson({
      ok: false,
      code: 'already_initialized',
      message: 'vault already has active tokens; use "rotate" or "list" instead',
      active: existing,
    });
    return 2;
  }
  const rec = await createToken({ source: 'init' });
  printJson({
    ok: true,
    action: 'init',
    kid: rec.kid,
    familyId: rec.familyId,
    token: rec.token,
    expiresAt: new Date(rec.expiresAt).toISOString(),
    warning: 'Save this token now. It will not be shown again. Distribute via secure channel.',
  });
  return 0;
}

async function cmdRotate(): Promise<number> {
  await tokenStoreInit();
  const existing = await listActiveKids();
  const currentActive = existing.filter((e) => e.status === 'active');
  if (currentActive.length === 0) {
    printJson({ ok: false, code: 'no_active_token', message: 'call "init" first' });
    return 2;
  }
  const rotated: any[] = [];
  for (const info of currentActive) {
    const old = await findByKid(info.kid);
    if (!old) continue;
    const fresh = await createToken({ parentKid: old.kid, source: 'rotate' });
    rotated.push({
      oldKid: old.kid,
      newKid: fresh.kid,
      familyId: fresh.familyId,
      newToken: fresh.token,
      graceUntil: old.graceUntil ? new Date(old.graceUntil).toISOString() : null,
    });
  }
  printJson({
    ok: true,
    action: 'rotate',
    rotated,
    warning: 'Old tokens remain valid during grace period. New tokens take effect immediately for new clients.',
  });
  return 0;
}

async function cmdRevokeKid(kid: string | undefined): Promise<number> {
  if (!kid) {
    printJson({ ok: false, code: 'missing_kid', message: 'usage: revoke <kid>' });
    return 2;
  }
  await tokenStoreInit();
  const ok = await revokeToken({ kid });
  printJson({ ok, action: 'revoke', kid, found: ok });
  return ok ? 0 : 1;
}

async function cmdRevokeFamily(familyId: string | undefined, flags: Map<string, string>): Promise<number> {
  if (!familyId) {
    printJson({ ok: false, code: 'missing_family', message: 'usage: revoke-family <familyId>' });
    return 2;
  }
  const reasonRaw = flags.get('reason') || 'manual';
  if (!VALID_REASONS.includes(reasonRaw as FamilyRevokeReason)) {
    printJson({ ok: false, code: 'invalid_reason', valid: VALID_REASONS });
    return 2;
  }
  await tokenStoreInit();
  const result = await revokeFamily({ familyId, reason: reasonRaw as FamilyRevokeReason });
  printJson({
    ok: true,
    action: 'revoke-family',
    familyId,
    reason: reasonRaw,
    revokedTokens: result.revokedTokens,
  });
  return 0;
}

async function cmdList(): Promise<number> {
  await tokenStoreInit();
  const all = await listActiveKids();
  printJson({ ok: true, action: 'list', count: all.length, tokens: all });
  for (const e of all) {
    process.stderr.write(shortStatus(e.kid, e.status, e.familyId, e.expiresAt) + '\n');
  }
  return 0;
}

async function cmdShow(kid: string | undefined): Promise<number> {
  if (!kid) {
    printJson({ ok: false, code: 'missing_kid', message: 'usage: show <kid>' });
    return 2;
  }
  await tokenStoreInit();
  const rec = await findByKid(kid);
  if (!rec) {
    printJson({ ok: false, code: 'not_found', kid });
    return 1;
  }
  printJson({
    ok: true,
    action: 'show',
    kid: rec.kid,
    familyId: rec.familyId,
    status: rec.status,
    createdAt: new Date(rec.createdAt).toISOString(),
    expiresAt: new Date(rec.expiresAt).toISOString(),
    graceUntil: rec.graceUntil ? new Date(rec.graceUntil).toISOString() : null,
    source: rec.source,
    token: rec.token,
  });
  return 0;
}

function printUsage(): void {
  process.stderr.write(`token-cli — SoloForge API token manager

USAGE:
  tsx scripts/token-cli.ts <command> [args...]

COMMANDS:
  init                          Create first active token (fails if vault already has active)
  rotate                        Rotate all active tokens; old enter grace period
  revoke <kid>                  Revoke a single kid (does not affect family)
  revoke-family <familyId>      Revoke entire family
       [--reason=reuse_detected|manual|expired]
  list                          List all non-revoked tokens (kid/status/family)
  show <kid>                    Print full record of a kid (including plaintext token)

OUTPUT: JSON to stdout. Run again with the new token in production via secure channel.
`);
}

async function main(): Promise<void> {
  const { cmd, rest, flags } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(cmd ? 0 : 1);
  }
  try {
    let rc = 0;
    switch (cmd) {
      case 'init': rc = await cmdInit(); break;
      case 'rotate': rc = await cmdRotate(); break;
      case 'revoke': rc = await cmdRevokeKid(rest[0]); break;
      case 'revoke-family': rc = await cmdRevokeFamily(rest[0], flags); break;
      case 'list': rc = await cmdList(); break;
      case 'show': rc = await cmdShow(rest[0]); break;
      default:
        printJson({ ok: false, code: 'unknown_command', cmd });
        printUsage();
        rc = 2;
    }
    process.exit(rc);
  } catch (e) {
    const err = e as Error;
    logger.error('token-cli', `failed: ${err.message}`);
    printJson({ ok: false, code: 'exception', message: err.message, stack: err.stack });
    process.exit(1);
  }
}

void main();
