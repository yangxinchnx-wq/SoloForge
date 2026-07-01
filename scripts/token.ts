// SoloForge Token 管理 CLI 工具
// Path: scripts/token.ts
//
// =====================================================================
// 作用
// =====================================================================
// 提供手动管理 API Token 的命令行入口,所有操作都走项目里现有的
// apiKeyVault(OS 钥匙串)。
//
// =====================================================================
// 命令清单
// =====================================================================
//   npx tsx scripts/token.ts init
//       生成一个新的 token 并写入 vault。如果 vault 已经有 token,
//       默认拒绝(防误覆盖),加 --force 强制覆盖。
//
//   npx tsx scripts/token.ts list [--reveal]
//       列出 vault 中所有 token(默认遮罩,加 --reveal 显示明文)。
//
//   npx tsx scripts/token.ts rotate
//       生成一个新 token,与现有 token 并存(用于平滑轮换)。
//       旧 token 仍然有效,直到你 npm run token:revoke 删除它。
//
//   npx tsx scripts/token.ts revoke
//       交互式:让用户选择要吊销的 token,然后从 vault 删除。
//       输入 all 一键清空。
//
//   npx tsx scripts/token.ts clear
//       无条件清空 vault 里所有 token。下次启动需要重新 init 或设 env。
//
//   npx tsx scripts/token.ts show [--reveal]
//       快速查看 token 配置概况(env 有几个 / vault 有几个 / 主 token 摘要)。
//
// =====================================================================
// 全局选项
// =====================================================================
//   --reveal    显示明文 token(默认遮罩为 abc...xyz len=64 形式)
//   --force     强制执行(用于 init 在已有 token 时覆盖)
//
// =====================================================================
// 安全说明
// =====================================================================
//   - 所有命令都通过 apiKeyVault 间接操作 OS 钥匙串,不走文件系统
//   - token 明文只在以下情况显示到 stdout:list/show 加了 --reveal 时,
//     或者 rotate/init 生成完立即打印的那一次(便于你复制到前端)
//   - 任何情况都不会把 token 写进日志文件
//   - revoke 直接从 OS 钥匙串物理删除条目,不做软删除
//
// =====================================================================
// 完整示例
// =====================================================================
//   # 第一次使用(无 token 时)
//   npm run token:init
//
//   # 看当前状态(不显示明文)
//   npm run token:show
//
//   # 轮换:加一个新 token,前端可以平滑切换
//   npm run token:rotate
//   # 输出会打印新 token,复制到前端
//
//   # 紧急吊销某个 token
//   npm run token:revoke
//   # 交互式选 1/2/3 或 all
//
//   # 看主 token 明文(排查用)
//   npm run token:list -- --reveal
//
import * as readline from 'readline';
import { generateApiToken, loadApiTokensAsync } from '../src/security/auth';
import { apiKeyVault } from '../src/security/apiKeyVault';

const VAULT_PROVIDER_ID = 'soloforge.api.tokens';

async function readTokensFromVault(): Promise<string[]> {
  await apiKeyVault.init();
  const stored = await apiKeyVault.getKey(VAULT_PROVIDER_ID);
  if (!stored || !stored.apiKey) return [];
  try {
    const arr = JSON.parse(Buffer.from(stored.apiKey, 'base64url').toString('utf8'));
    return Array.isArray(arr) ? arr.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

async function writeTokensToVault(tokens: string[]): Promise<void> {
  await apiKeyVault.init();
  const blob = Buffer.from(JSON.stringify(tokens), 'utf8').toString('base64url');
  await apiKeyVault.setKey(VAULT_PROVIDER_ID, blob, 'vault://api-tokens');
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function maskToken(t: string): string {
  if (t.length < 12) return '***';
  return t.slice(0, 6) + '...' + t.slice(-4) + ' (len=' + t.length + ')';
}

// ============================================================
// 命令:init
// ============================================================
// 生成新 token 并写入 vault。
// 行为:
//   - 如果 vault 已有 token,默认拒绝(防误覆盖)
//   - 加 --force 强制覆盖
//   - 生成成功后会立即打印明文 token 一次,方便用户复制到前端
//   - 之后该 token 就只能通过 --reveal 看到明文
function cmdInit(): Promise<void> {
  return (async () => {
    const existing = await readTokensFromVault();
    if (existing.length > 0 && !process.argv.includes('--force')) {
      console.log('[token] vault 已经有 ' + existing.length + ' 个 token,先用 rotate 或 clear,或加 --force 强制覆盖。');
      return;
    }
    const fresh = generateApiToken();
    await writeTokensToVault([fresh]);
    console.log('[token] 已生成新 token(立即复制到前端,关掉窗口就看不到了):');
    console.log('        ' + fresh + '   // 唯一一次明文显示');
    console.log('[token] 已保存到 OS 钥匙串(vault)。本机前端可以通过 GET /api/auth/bootstrap 获取。');
  })();
}

// ============================================================
// 命令:list [--reveal]
// ============================================================
// 列出 vault 中所有 token。
// 行为:
//   - 默认遮罩(token 前后几位 + 长度,中间 ... 替代)
//   - 加 --reveal 才打印明文(用于排查)
//   - 同时打印索引 [1] [2] [3],便于 revoke 时引用
function cmdList(): Promise<void> {
  return (async () => {
    const tokens = await readTokensFromVault();
    const reveal = process.argv.includes('--reveal');
    console.log('[token] vault 中有 ' + tokens.length + ' 个 token:');
    tokens.forEach((t, i) => {
      const display = reveal ? t : maskToken(t);
      const tag = reveal ? '   <- 明文' : '';
      console.log('  [' + (i + 1) + '] ' + display + tag);
    });
  })();
}

// ============================================================
// 命令:rotate
// ============================================================
// 添加一个新 token,与现有 token 并存。
// 适用场景:
//   - 怀疑旧 token 可能泄露,想换新的但前端不能停机
//   - 工作流:rotate -> 前端拿新 token -> 验证新 token 正常 ->
//     revoke 旧 token(通过 npm run token:revoke)
// 注意:rotate 不删旧 token,只在 vault 追加。
function cmdRotate(): Promise<void> {
  return (async () => {
    const existing = await readTokensFromVault();
    const fresh = generateApiToken();
    const next = [...existing, fresh];
    await writeTokensToVault(next);
    console.log('[token] 已添加新 token。当前活跃总数: ' + next.length + '。');
    console.log('        new = ' + fresh + '   // 复制这个到前端');
    console.log('[token] 旧 token 仍然有效,用于平滑迁移(前端可以慢慢切到新 token)。');
    console.log('[token] 想下线旧 token 用 npm run token:revoke,或者加到 SOLOFORGE_REVOKED_TOKENS 环境变量。');
  })();
}

// ============================================================
// 命令:revoke
// ============================================================
// 交互式吊销指定 token。
// 行为:
//   - 先列出所有 token(遮罩形式)
//   - 用户输入要吊销的索引号,或者输入 all 清空
//   - 立即从 vault 删除,不可恢复(下次启动时已吊销 token 的请求会被拒)
// 适用场景:旧 token 已经被前端废弃,需要从 vault 物理删除。
function cmdRevoke(): Promise<void> {
  return (async () => {
    const tokens = await readTokensFromVault();
    if (tokens.length === 0) {
      console.log('[token] vault 里没有 token。');
      return;
    }
    console.log('[token] 当前 token 列表:');
    tokens.forEach((t, i) => console.log('  [' + (i + 1) + '] ' + maskToken(t)));
    const idxStr = await prompt('吊销哪个?(输入序号,或输入 all 清空): ');
    if (idxStr === 'all') {
      await writeTokensToVault([]);
      console.log('[token] 所有 token 已清空。重启服务后需要重新 init 或设置 env。');
      return;
    }
    const idx = parseInt(idxStr, 10);
    if (isNaN(idx) || idx < 1 || idx > tokens.length) {
      console.log('[token] 序号无效,操作已取消。');
      return;
    }
    const removed = tokens.splice(idx - 1, 1);
    await writeTokensToVault(tokens);
    console.log('[token] 已吊销: ' + maskToken(removed[0]));
    console.log('[token] 剩余 ' + tokens.length + ' 个 token。');
  })();
}

// ============================================================
// 命令:clear
// ============================================================
// 无条件清空 vault 里所有 token。
// 注意:这是不可逆操作,执行后下次启动需要重新 init 或设 env。
// 如果只是想换 token,优先用 rotate + revoke,而不是 clear。
function cmdClear(): Promise<void> {
  return (async () => {
    await writeTokensToVault([]);
    console.log('[token] 已清空所有 token。下次启动需重新 init 或设置 env。');
  })();
}

// ============================================================
// 命令:show [--reveal]
// ============================================================
// 快速查看 token 配置概况。
// 输出三段信息:
//   1) 环境变量 SOLOFORGE_API_TOKENS 是否设置,有几个 token
//   2) vault 中有几个 token
//   3) 主 token(第一个):默认遮罩,加 --reveal 显示明文
//   4) 启动时 token 解析顺序的提示
function cmdShow(): Promise<void> {
  return (async () => {
    const env = process.env.SOLOFORGE_API_TOKENS;
    if (env) {
      const envTokens = env.split(',').map((s) => s.trim()).filter(Boolean);
      console.log('[token] 环境变量 SOLOFORGE_API_TOKENS 持有 ' + envTokens.length + ' 个 token(env 优先于 vault)。');
    } else {
      console.log('[token] 环境变量 SOLOFORGE_API_TOKENS 未设置(将走 vault 或自动生成)。');
    }
    const vault = await readTokensFromVault();
    console.log('[token] vault 持有 ' + vault.length + ' 个 token。');
    if (process.argv.includes('--reveal') && vault.length > 0) {
      console.log('[token] 主 token(明文,已 --reveal): ' + vault[0]);
    } else if (vault.length > 0) {
      console.log('[token] 主 token: ' + maskToken(vault[0]));
    }
    console.log('[token] 启动期 token 解析顺序:env -> vault -> 自动生成(需 SOLOFORGE_REQUIRE_TOKENS=0)');
  })();
}

// 默认命令:无参数时显示概况(等同 show)
const command = process.argv[2] || 'show';
const handlers: Record<string, () => Promise<void>> = {
  init: cmdInit,
  list: cmdList,
  rotate: cmdRotate,
  revoke: cmdRevoke,
  clear: cmdClear,
  show: cmdShow,
};

const h = handlers[command];
if (!h) {
  console.log('=========================================');
  console.log('未知命令: ' + command);
  console.log('=========================================');
  console.log('');
  console.log('可用命令:');
  console.log('  init       生成新 token 并写入 vault');
  console.log('  list       列出 vault 中所有 token(加 --reveal 显示明文)');
  console.log('  rotate     追加一个新 token,与现有并存');
  console.log('  revoke     交互式吊销指定 token');
  console.log('  clear      清空 vault 所有 token');
  console.log('  show       显示 token 配置概况(默认命令)');
  console.log('');
  console.log('全局选项:');
  console.log('  --reveal   显示 token 明文(默认遮罩)');
  console.log('  --force    强制执行(用于 init 覆盖已有 token)');
  console.log('');
  console.log('完整用法: npx tsx scripts/token.ts <命令> [--reveal] [--force]');
  console.log('         或:   npm run token:<init|list|rotate|revoke|clear|show>');
  console.log('=========================================');
  process.exit(1);
}

h().catch((e) => {
  console.error('[token] 错误: ' + e.message);
  process.exit(1);
});