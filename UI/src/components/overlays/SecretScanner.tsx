// ─────────────────────────────────────────────────────────────────
// 密钥扫描器 — SecretScanner
// - 检测代码中的硬编码密钥 (AWS/GitHub/Stripe/...)
// - 正则规则 + 熵值分析
// - 风险评级 + 修复建议
// - 扫描历史 + 误报标记
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Finding {
  id: string;
  file: string;
  line: number;
  type: string;
  pattern: string;
  value: string;       // 脱敏
  raw: string;
  risk: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  description: string;
  fix: string;
  falsePositive?: boolean;
}

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp; risk: Finding['risk']; cat: string; fix: string; desc: string }> = [
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g, risk: 'critical', cat: '云密钥', fix: '使用 IAM Role 或 AWS SSO 替代,不要硬编码', desc: 'AWS 访问密钥 ID,泄露后可访问您的 AWS 账户' },
  { name: 'AWS Secret Key', regex: /aws_secret_access_key\s*=\s*['"]?([A-Za-z0-9/+=]{40})['"]?/g, risk: 'critical', cat: '云密钥', fix: '使用环境变量或 AWS Secrets Manager', desc: 'AWS 秘密访问密钥' },
  { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9]{36,255}/g, risk: 'critical', cat: '代码平台', fix: '使用 GitHub Actions Secrets,撤销此 token', desc: 'GitHub Personal Access Token' },
  { name: 'GitHub Fine-grained', regex: /github_pat_[A-Za-z0-9_]{82}/g, risk: 'critical', cat: '代码平台', fix: '撤销并轮换,使用环境变量', desc: 'GitHub Fine-grained PAT' },
  { name: 'Slack Token', regex: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,32}/g, risk: 'high', cat: '通讯', fix: '使用 OAuth 安装而非 webhook token', desc: 'Slack Bot/User/App Token' },
  { name: 'Stripe Live Key', regex: /sk_live_[0-9a-zA-Z]{24,99}/g, risk: 'critical', cat: '支付', fix: '立即在 Stripe Dashboard 轮换此 key', desc: 'Stripe Live 模式密钥,泄露可扣款' },
  { name: 'Stripe Test Key', regex: /sk_test_[0-9a-zA-Z]{24,99}/g, risk: 'medium', cat: '支付', fix: '从代码中移除,使用环境变量', desc: 'Stripe Test 模式密钥' },
  { name: 'Google API Key', regex: /AIza[0-9A-Za-z_-]{35}/g, risk: 'high', cat: '云密钥', fix: '限制 API Key 域名/IP,在 GCP Console 撤销', desc: 'Google API Key' },
  { name: 'OpenAI API Key', regex: /sk-[A-Za-z0-9]{48,}/g, risk: 'critical', cat: 'AI 服务', fix: '在 platform.openai.com 撤销并轮换', desc: 'OpenAI API Key,泄露会产生高额账单' },
  { name: 'Anthropic API Key', regex: /sk-ant-[A-Za-z0-9_-]{40,}/g, risk: 'critical', cat: 'AI 服务', fix: '在 console.anthropic.com 撤销并轮换', desc: 'Anthropic API Key' },
  { name: 'JWT Token', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, risk: 'high', cat: '认证', fix: 'JWT 不应硬编码,使用短期 token + 刷新机制', desc: 'JSON Web Token' },
  { name: 'Private Key Block', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, risk: 'critical', cat: '密钥对', fix: '使用密钥管理服务 (KMS/Vault),不要提交到代码', desc: '私钥文件内容' },
  { name: 'Generic Password Assignment', regex: /(?:password|passwd|pwd)\s*[=:]\s*['"]([^'"]{8,})['"]/gi, risk: 'medium', cat: '凭证', fix: '使用环境变量或密钥库,不要硬编码', desc: '硬编码密码' },
  { name: 'Generic API Key', regex: /(?:api[_-]?key|apikey)\s*[=:]\s*['"]([A-Za-z0-9_-]{20,})['"]/gi, risk: 'high', cat: '凭证', fix: '移到 .env 或密钥管理', desc: '通用 API Key 模式' },
  { name: 'Generic Token', regex: /(?:token|auth[_-]?token|access[_-]?token)\s*[=:]\s*['"]([A-Za-z0-9_.-]{20,})['"]/gi, risk: 'high', cat: '凭证', fix: '使用 OAuth 流程,不要硬编码', desc: '通用 Token 模式' },
  { name: 'Database URL', regex: /(?:postgres|mysql|mongodb):\/\/[^:]+:[^@]+@[^\s'"]+/g, risk: 'critical', cat: '数据库', fix: '使用环境变量,启用 SSL,限制 IP 访问', desc: '数据库连接字符串含密码' },
  { name: 'Slack Webhook', regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{24}/g, risk: 'high', cat: '通讯', fix: '使用环境变量,定期轮换', desc: 'Slack Incoming Webhook URL' },
  { name: 'Heroku API Key', regex: /heroku[a-z0-9_ .\-,]{0,20}(?:[=:]|api[_-]?key)[^\n]+['"]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]/gi, risk: 'critical', cat: '云密钥', fix: '撤销并轮换,使用 Heroku OAuth', desc: 'Heroku API Key (UUID 格式)' },
];

const SAMPLE_FILES: Array<{ path: string; content: string }> = [
  {
    path: 'src/config/aws.ts',
    content: `// AWS Configuration
export const AWS_CONFIG = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1'
};

export const S3_BUCKET = 'my-prod-data';`
  },
  {
    path: 'src/api/payment.ts',
    content: `import Stripe from 'stripe';

// 严重: 不应在代码中硬编码
const STRIPE_KEY = 'sk_live_REDACTED_DEMO';
const stripe = new Stripe(STRIPE_KEY);

export async function charge(amount: number) {
  return await stripe.charges.create({ amount, currency: 'usd' });
}`
  },
  {
    path: 'src/services/ai.ts',
    content: `// OpenAI
const OPENAI_KEY = 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';
const ANTHROPIC_KEY = 'sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyzABCDEFG';

// 调用 AI
export async function askAI(prompt: string) {
  return await fetch('https://api.openai.com/v1/chat', {
    headers: { 'Authorization': \`Bearer \${OPENAI_KEY}\` }
  });
}`
  },
  {
    path: 'src/api/auth.ts',
    content: `const GITHUB_TOKEN = 'ghp_1234567890abcdefghijklmnopqrstuvwx';
const password = 'MyP@ssw0rd123!Secure';

export async function getUser() {
  return await fetch('https://api.github.com/user', {
    headers: { 'Authorization': \`token \${GITHUB_TOKEN}\` }
  });
}`
  },
  {
    path: 'src/lib/db.ts',
    content: `const MONGO_URL = 'mongodb://admin:supersecret123@cluster0.mongodb.net:27017/myapp?ssl=true';
const POSTGRES_URL = 'postgres://user:pass123@localhost:5432/prod';

export const db = connect(MONGO_URL);`
  },
  {
    path: 'src/lib/safe.ts',
    content: `// 这个文件应该是安全的
import { getEnv } from '../utils';

const API_KEY = getEnv('API_KEY'); // OK
const DB_URL = getEnv('DATABASE_URL'); // OK
export const VERSION = '1.2.3';
export const MAX_RETRIES = 3;`
  },
  {
    path: 'scripts/deploy.sh',
    content: `#!/bin/bash
# 部署脚本
export SLACK_WEBHOOK="https://hooks.slack.com/services/REDACTED"
export HEROKU_API_KEY="12345678-1234-1234-1234-123456789012"

curl -X POST $SLACK_WEBHOOK -d '{"text":"Deploy started"}'
git push heroku main`
  },
  {
    path: 'certs/private.key',
    content: `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz
ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnop
qrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdef
-----END RSA PRIVATE KEY-----`
  },
];

const STORE = 'soloforge.secret-scanner.v1';
const STORE_FP = 'soloforge.secret-scanner.fp.v1';

function loadFP(): string[] { try { const r = localStorage.getItem(STORE_FP); if (r) return JSON.parse(r); } catch { /* */ } return []; }
function saveFP(v: string[]) { try { localStorage.setItem(STORE_FP, JSON.stringify(v)); } catch { /* */ } }

function maskValue(s: string): string {
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 4) + '*'.repeat(Math.max(4, s.length - 8)) + s.slice(-4);
}

function calcEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq: Record<string, number> = {};
  for (const c of s) freq[c] = (freq[c] || 0) + 1;
  let ent = 0;
  for (const c in freq) {
    const p = freq[c] / s.length;
    ent -= p * Math.log2(p);
  }
  return ent;
}

export function SecretScanner({ open, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'findings' | 'rules' | 'history'>('overview');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [falsePositives, setFalsePositives] = useState<string[]>(loadFP);
  const [history, setHistory] = useState<Array<{ ts: number; total: number; critical: number }>>([]);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => { saveFP(falsePositives); }, [falsePositives]);

  const runScan = useCallback(() => {
    setScanning(true);
    setScanned(false);
    setTimeout(() => {
      const results: Finding[] = [];
      let id = 0;
      for (const file of SAMPLE_FILES) {
        for (const pat of SECRET_PATTERNS) {
          // 每次正则需要重置 lastIndex
          pat.regex.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = pat.regex.exec(file.content)) !== null) {
            const lines = file.content.slice(0, match.index).split('\n').length;
            const value = match[1] || match[0];
            const ent = calcEntropy(value);
            const f: Finding = {
              id: 'f_' + (id++),
              file: file.path,
              line: lines,
              type: pat.name,
              pattern: pat.regex.source.slice(0, 40) + '...',
              value: maskValue(value),
              raw: value,
              risk: ent > 4.5 && pat.risk !== 'critical' ? 'high' : pat.risk,
              category: pat.cat,
              description: pat.desc,
              fix: pat.fix,
            };
            results.push(f);
          }
        }
      }
      setFindings(results);
      setScanning(false);
      setScanned(true);
      setHistory(prev => [{ ts: Date.now(), total: results.length, critical: results.filter(r => r.risk === 'critical').length }, ...prev].slice(0, 20));
    }, 1200);
  }, []);

  // 自动扫描
  useEffect(() => {
    if (open && !scanned && !scanning) {
      runScan();
    }
  }, [open, scanned, scanning, runScan]);

  const visible = useMemo(() => {
    return findings
      .filter(f => !falsePositives.includes(f.id))
      .filter(f => filter === 'all' || f.risk === filter)
      .sort((a, b) => {
        const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        return order[a.risk] - order[b.risk];
      });
  }, [findings, falsePositives, filter]);

  const stats = useMemo(() => {
    const active = findings.filter(f => !falsePositives.includes(f.id));
    return {
      total: active.length,
      critical: active.filter(f => f.risk === 'critical').length,
      high: active.filter(f => f.risk === 'high').length,
      medium: active.filter(f => f.risk === 'medium').length,
      low: active.filter(f => f.risk === 'low').length,
      byCategory: active.reduce<Record<string, number>>((m, f) => { m[f.category] = (m[f.category] || 0) + 1; return m; }, {}),
      byFile: active.reduce<Record<string, number>>((m, f) => { m[f.file] = (m[f.file] || 0) + 1; return m; }, {}),
    };
  }, [findings, falsePositives]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">key_off</span>
          <h2 className="text-sm font-semibold text-text">密钥扫描器</h2>
          <Badge variant="danger">⚠ {stats.critical} critical</Badge>
          <Badge variant="warning">{stats.high} high</Badge>
          <Badge variant="info">{stats.total} 总计</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="search" onClick={runScan} loading={scanning} variant="primary">重新扫描</Button>
            <Button size="sm" icon="file_download">导出报告</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'overview', l: '概览' },
            { k: 'findings', l: `发现 (${visible.length})` },
            { k: 'rules',    l: `规则 (${SECRET_PATTERNS.length})` },
            { k: 'history',  l: `历史 (${history.length})` },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3">
          {tab === 'overview' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-danger/10 border border-danger/30 rounded-lg p-3">
                  <p className="text-[10px] text-danger">严重</p>
                  <p className="text-2xl font-bold text-danger">{stats.critical}</p>
                </div>
                <div className="bg-warning/10 border border-warning/30 rounded-lg p-3">
                  <p className="text-[10px] text-warning">高</p>
                  <p className="text-2xl font-bold text-warning">{stats.high}</p>
                </div>
                <div className="bg-info/10 border border-info/30 rounded-lg p-3">
                  <p className="text-[10px] text-info">中</p>
                  <p className="text-2xl font-bold text-info">{stats.medium}</p>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">低</p>
                  <p className="text-2xl font-bold text-text-secondary">{stats.low}</p>
                </div>
              </div>

              {scanning ? (
                <div className="bg-bg border border-border-light rounded-lg p-6 text-center">
                  <span className="material-symbols-outlined text-3xl text-accent animate-spin">progress_activity</span>
                  <p className="text-sm text-text mt-2">正在扫描 {SAMPLE_FILES.length} 个文件...</p>
                  <p className="text-[10px] text-text-secondary mt-1">{SECRET_PATTERNS.length} 条规则匹配中</p>
                </div>
              ) : (
                <>
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">按类别</h3>
                    {Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
                      <div key={cat} className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] text-text w-20">{cat}</span>
                        <div className="flex-1 h-2 bg-surface-high rounded overflow-hidden">
                          <div className="h-full bg-danger" style={{ width: (count / Math.max(stats.total, 1) * 100) + '%' }} />
                        </div>
                        <span className="text-[10px] font-mono text-text w-8 text-right">{count}</span>
                      </div>
                    ))}
                  </div>

                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">按文件</h3>
                    {Object.entries(stats.byFile).sort((a, b) => b[1] - a[1]).map(([file, count]) => (
                      <div key={file} onClick={() => setTab('findings')} className="flex items-center gap-2 mb-1 cursor-pointer hover:bg-surface-high rounded px-1 py-0.5">
                        <span className="material-symbols-outlined text-xs text-text-secondary">description</span>
                        <code className="text-[10px] font-mono text-text flex-1 truncate">{file}</code>
                        <Badge variant={count > 2 ? 'danger' : count > 0 ? 'warning' : 'default'}>{count}</Badge>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'findings' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-1 border-b border-border-light flex items-center gap-1">
                <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
                  {(['all', 'critical', 'high', 'medium', 'low'] as const).map(f => (
                    <button key={f} onClick={() => setFilter(f)} className={'px-2 h-5 rounded text-[10px] ' + (filter === f ? 'bg-surface-high text-text' : 'text-text-secondary')}>
                      {f}
                    </button>
                  ))}
                </div>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5 w-16">风险</th>
                    <th className="text-left px-2 py-1.5 w-32">类型</th>
                    <th className="text-left px-2 py-1.5">文件:行</th>
                    <th className="text-left px-2 py-1.5 w-32">脱敏值</th>
                    <th className="text-left px-2 py-1.5">修复建议</th>
                    <th className="text-left px-2 py-1.5 w-16">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(f => (
                    <tr key={f.id} className="border-t border-border-light">
                      <td className="px-2 py-1">
                        <Badge variant={f.risk === 'critical' ? 'danger' : f.risk === 'high' ? 'warning' : f.risk === 'medium' ? 'info' : 'default'}>{f.risk}</Badge>
                      </td>
                      <td className="px-2 py-1 text-[10px] text-text">{f.type}</td>
                      <td className="px-2 py-1">
                        <code className="text-[10px] font-mono text-text-secondary">{f.file}</code>
                        <span className="text-text-secondary">:{f.line}</span>
                      </td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text">{f.value}</td>
                      <td className="px-2 py-1 text-[10px] text-text-secondary">{f.fix}</td>
                      <td className="px-2 py-1">
                        <Button size="xs" onClick={() => setFalsePositives([...falsePositives, f.id])} title="标记为误报">忽略</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'rules' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5">名称</th>
                    <th className="text-left px-2 py-1.5 w-20">风险</th>
                    <th className="text-left px-2 py-1.5 w-24">类别</th>
                    <th className="text-left px-2 py-1.5">正则</th>
                  </tr>
                </thead>
                <tbody>
                  {SECRET_PATTERNS.map(p => (
                    <tr key={p.name} className="border-t border-border-light">
                      <td className="px-2 py-1 text-text">{p.name}</td>
                      <td className="px-2 py-1"><Badge variant={p.risk === 'critical' ? 'danger' : p.risk === 'high' ? 'warning' : 'info'}>{p.risk}</Badge></td>
                      <td className="px-2 py-1 text-text-secondary">{p.cat}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text-secondary truncate">{p.regex.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'history' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5">时间</th>
                    <th className="text-right px-2 py-1.5 w-20">总数</th>
                    <th className="text-right px-2 py-1.5 w-20">严重</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 ? <tr><td colSpan={3} className="text-center text-text-secondary py-4">暂无历史</td></tr> :
                    history.map((h, i) => (
                      <tr key={i} className="border-t border-border-light">
                        <td className="px-2 py-1 text-text-secondary">{new Date(h.ts).toLocaleString()}</td>
                        <td className="px-2 py-1 text-right font-mono text-text">{h.total}</td>
                        <td className="px-2 py-1 text-right font-mono text-danger">{h.critical}</td>
                      </tr>
                    ))
                  }
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>{SAMPLE_FILES.length} 文件扫描</span>
          <span>·</span>
          <span>{SECRET_PATTERNS.length} 检测规则</span>
          <span>·</span>
          <span>支持熵值分析</span>
          <span>·</span>
          <span>扫描时间: {scanning ? '进行中' : '~1.2s'}</span>
        </div>
      </div>
    </div>
  );
}
