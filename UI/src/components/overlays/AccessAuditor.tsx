// ─────────────────────────────────────────────────────────────────
// 访问审计器 — AccessAuditor
// - 用户登录/操作审计
// - 权限/角色矩阵
// - 异常行为检测
// - 会话管理
// - SSO 审计
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'developer' | 'analyst' | 'viewer' | 'service';
  mfa: boolean;
  lastLogin: number;
  lastIp: string;
  failedAttempts: number;
  status: 'active' | 'disabled' | 'locked' | 'pending';
  department: string;
  joined: number;
  ssoProvider?: 'google' | 'github' | 'okta' | 'azure';
}

interface AuditEvent {
  id: string;
  ts: number;
  user: string;
  action: string;
  resource: string;
  ip: string;
  geo: string;
  device: string;
  result: 'success' | 'failure' | 'blocked';
  risk: 'low' | 'medium' | 'high';
  details: string;
}

interface Session {
  id: string;
  user: string;
  ip: string;
  device: string;
  geo: string;
  started: number;
  lastActive: number;
  expires: number;
  active: boolean;
}

const USERS: User[] = [
  { id: 'u1', name: 'Alice Chen',     email: 'alice@soloforge.com',  role: 'admin',     mfa: true,  lastLogin: Date.now() - 3600000,  lastIp: '203.0.113.45',  failedAttempts: 0,  status: 'active',   department: 'Engineering', joined: Date.now() - 365 * 86400000, ssoProvider: 'google' },
  { id: 'u2', name: 'Bob Wang',       email: 'bob@soloforge.com',    role: 'developer', mfa: true,  lastLogin: Date.now() - 7200000,  lastIp: '198.51.100.23', failedAttempts: 0,  status: 'active',   department: 'Engineering', joined: Date.now() - 180 * 86400000, ssoProvider: 'github' },
  { id: 'u3', name: 'Carol Liu',      email: 'carol@soloforge.com',  role: 'analyst',   mfa: true,  lastLogin: Date.now() - 1800000,  lastIp: '203.0.113.78',  failedAttempts: 0,  status: 'active',   department: 'Data',        joined: Date.now() - 90 * 86400000, ssoProvider: 'okta' },
  { id: 'u4', name: 'David Zhang',    email: 'david@soloforge.com',  role: 'developer', mfa: false, lastLogin: Date.now() - 86400000,  lastIp: '203.0.113.99',  failedAttempts: 0,  status: 'active',   department: 'Engineering', joined: Date.now() - 30 * 86400000 },
  { id: 'u5', name: 'Eve (Service)',  email: 'svc-deploy@soloforge', role: 'service',   mfa: false, lastLogin: Date.now() - 600000,   lastIp: '10.0.0.5',      failedAttempts: 0,  status: 'active',   department: 'Platform',    joined: Date.now() - 365 * 86400000 },
  { id: 'u6', name: 'Frank Brown',    email: 'frank@external.io',    role: 'viewer',    mfa: false, lastLogin: Date.now() - 1800000,  lastIp: '45.83.91.12',   failedAttempts: 7,  status: 'locked',   department: 'External',    joined: Date.now() - 7 * 86400000 },
  { id: 'u7', name: 'Grace (待审)',   email: 'grace@partner.com',    role: 'viewer',    mfa: false, lastLogin: 0,                    lastIp: '',                failedAttempts: 0,  status: 'pending',  department: 'Partner',     joined: Date.now() - 86400000 },
  { id: 'u8', name: 'Henry (已禁用)', email: 'henry@former.com',     role: 'developer', mfa: true,  lastLogin: Date.now() - 30 * 86400000, lastIp: '203.0.113.1',   failedAttempts: 0,  status: 'disabled', department: 'Engineering', joined: Date.now() - 200 * 86400000 },
];

const SEED_EVENTS: AuditEvent[] = [
  { id: 'a1', ts: Date.now() - 30000,    user: 'alice@soloforge.com', action: 'user.create',         resource: 'users/bob',           ip: '203.0.113.45',  geo: '北京, CN', device: 'Chrome/macOS', result: 'success', risk: 'low',    details: '创建新用户 bob' },
  { id: 'a2', ts: Date.now() - 60000,    user: 'frank@external.io',   action: 'auth.login',          resource: 'auth',               ip: '45.83.91.12',   geo: '莫斯科, RU', device: 'Firefox/Linux', result: 'failure', risk: 'high',  details: '密码错误 (尝试 3/5)' },
  { id: 'a3', ts: Date.now() - 120000,   user: 'frank@external.io',   action: 'auth.login',          resource: 'auth',               ip: '45.83.91.12',   geo: '莫斯科, RU', device: 'Firefox/Linux', result: 'failure', risk: 'high',  details: '密码错误 (尝试 4/5)' },
  { id: 'a4', ts: Date.now() - 180000,   user: 'frank@external.io',   action: 'auth.login',          resource: 'auth',               ip: '45.83.91.12',   geo: '莫斯科, RU', device: 'Firefox/Linux', result: 'failure', risk: 'high',  details: '密码错误 (尝试 5/5) - 账户已锁定' },
  { id: 'a5', ts: Date.now() - 240000,   user: 'svc-deploy',          action: 'deploy.execute',      resource: 'production',         ip: '10.0.0.5',      geo: '内部',     device: 'CI/CD',          result: 'success', risk: 'medium', details: '部署 v1.2.4 到 production' },
  { id: 'a6', ts: Date.now() - 300000,   user: 'bob@soloforge.com',   action: 'repo.push',           resource: 'repo/main',          ip: '198.51.100.23', geo: '上海, CN', device: 'Git CLI',       result: 'success', risk: 'low',    details: '提交 a1b2c3d' },
  { id: 'a7', ts: Date.now() - 600000,   user: 'carol@soloforge.com', action: 'data.export',         resource: 'reports/q4',         ip: '203.0.113.78',  geo: '深圳, CN', device: 'Chrome/Win',     result: 'success', risk: 'medium', details: '导出 1240 行数据' },
  { id: 'a8', ts: Date.now() - 900000,   user: 'unknown',             action: 'auth.login',          resource: 'auth',               ip: '185.220.101.50',geo: 'Tor 出口',  device: 'Unknown',        result: 'blocked', risk: 'high',  details: 'Tor 出口节点,已阻止' },
  { id: 'a9', ts: Date.now() - 1200000,  user: 'alice@soloforge.com', action: 'settings.update',     resource: 'auth/mfa',           ip: '203.0.113.45',  geo: '北京, CN', device: 'Chrome/macOS', result: 'success', risk: 'low',    details: '为 david 启用 MFA' },
  { id: 'a10',ts: Date.now() - 1800000,  user: 'david@soloforge.com', action: 'auth.login',          resource: 'auth',               ip: '203.0.113.99',  geo: '广州, CN', device: 'Safari/iOS',    result: 'success', risk: 'low',    details: 'SSO 登录 (Google)' },
];

const SEED_SESSIONS: Session[] = [
  { id: 's1', user: 'alice@soloforge.com', ip: '203.0.113.45',  device: 'Chrome 125/macOS',    geo: '北京, CN', started: Date.now() - 3600000,  lastActive: Date.now() - 30000,  expires: Date.now() + 28800000, active: true },
  { id: 's2', user: 'bob@soloforge.com',   ip: '198.51.100.23', device: 'Firefox 127/Win11',   geo: '上海, CN', started: Date.now() - 7200000,  lastActive: Date.now() - 60000,  expires: Date.now() + 25200000, active: true },
  { id: 's3', user: 'carol@soloforge.com', ip: '203.0.113.78',  device: 'Edge 124/Win11',      geo: '深圳, CN', started: Date.now() - 1800000,  lastActive: Date.now() - 120000, expires: Date.now() + 30600000, active: true },
  { id: 's4', user: 'david@soloforge.com', ip: '203.0.113.99',  device: 'Safari 17/iOS 17',    geo: '广州, CN', started: Date.now() - 86400000, lastActive: Date.now() - 300000, expires: Date.now() + 0,         active: false },
  { id: 's5', user: 'svc-deploy',          ip: '10.0.0.5',      device: 'CI/CD Runner',        geo: '内部',    started: Date.now() - 600000,   lastActive: Date.now() - 60000,  expires: Date.now() + 86400000, active: true },
];

const PERMISSIONS = [
  { resource: '用户管理',  actions: { admin: 'CRUD', developer: 'R', analyst: 'R', viewer: 'R', service: 'R' } },
  { resource: '代码仓库',  actions: { admin: 'CRUD', developer: 'CRUD', analyst: 'R', viewer: 'R', service: 'R' } },
  { resource: '数据库',    actions: { admin: 'CRUD', developer: 'RU',  analyst: 'R', viewer: '—', service: 'CRUD' } },
  { resource: '生产环境',  actions: { admin: 'CRUD', developer: 'R',   analyst: '—', viewer: '—', service: 'CRUD' } },
  { resource: '日志',      actions: { admin: 'CRUD', developer: 'R',   analyst: 'R',  viewer: '—', service: 'R' } },
  { resource: '密钥',      actions: { admin: 'CRUD', developer: '—',   analyst: '—',  viewer: '—', service: 'R' } },
  { resource: '账单',      actions: { admin: 'CRUD', developer: 'R',   analyst: 'R',  viewer: '—', service: '—' } },
  { resource: '设置',      actions: { admin: 'CRUD', developer: '—',   analyst: '—',  viewer: '—', service: '—' } },
];

const STORE = 'soloforge.access-auditor.v1';

export function AccessAuditor({ open, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'users' | 'events' | 'sessions' | 'rbac'>('overview');
  const [filter, setFilter] = useState<'all' | 'high' | 'failure'>('all');
  const [userFilter, setUserFilter] = useState<string>('all');

  const stats = useMemo(() => {
    return {
      totalUsers: USERS.length,
      active: USERS.filter(u => u.status === 'active').length,
      noMfa: USERS.filter(u => !u.mfa && u.status === 'active').length,
      locked: USERS.filter(u => u.status === 'locked').length,
      highRiskEvents: SEED_EVENTS.filter(e => e.risk === 'high').length,
      failedLogins: SEED_EVENTS.filter(e => e.action === 'auth.login' && e.result === 'failure').length,
      activeSessions: SEED_SESSIONS.filter(s => s.active).length,
    };
  }, []);

  const visibleEvents = useMemo(() => {
    return SEED_EVENTS
      .filter(e => filter === 'all' || (filter === 'high' ? e.risk === 'high' : e.result === filter))
      .filter(e => userFilter === 'all' || e.user === userFilter);
  }, [filter, userFilter]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">manage_accounts</span>
          <h2 className="text-sm font-semibold text-text">访问审计器</h2>
          <Badge variant="primary">{stats.totalUsers} 用户</Badge>
          <Badge variant="warning">{stats.noMfa} 未启用 MFA</Badge>
          {stats.locked > 0 && <Badge variant="danger">{stats.locked} 锁定</Badge>}
          <Badge variant="info">{stats.activeSessions} 活跃会话</Badge>
          {stats.highRiskEvents > 0 && <Badge variant="danger">⚠ {stats.highRiskEvents} 高风险</Badge>}
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="file_download">审计报告</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'overview', l: '概览' },
            { k: 'users',    l: `用户 (${USERS.length})` },
            { k: 'events',   l: `事件 (${visibleEvents.length})` },
            { k: 'sessions', l: `会话 (${SEED_SESSIONS.length})` },
            { k: 'rbac',     l: '权限矩阵' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3">
          {tab === 'overview' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">活跃用户</p>
                  <p className="text-2xl font-bold text-success">{stats.active}/{stats.totalUsers}</p>
                </div>
                <div className="bg-warning/10 border border-warning/30 rounded-lg p-3">
                  <p className="text-[10px] text-warning">未启用 MFA</p>
                  <p className="text-2xl font-bold text-warning">{stats.noMfa}</p>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">活跃会话</p>
                  <p className="text-2xl font-bold text-text">{stats.activeSessions}</p>
                </div>
                <div className="bg-danger/10 border border-danger/30 rounded-lg p-3">
                  <p className="text-[10px] text-danger">失败登录</p>
                  <p className="text-2xl font-bold text-danger">{stats.failedLogins}</p>
                </div>
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">最近高风险事件</h3>
                <div className="space-y-1">
                  {SEED_EVENTS.filter(e => e.risk === 'high').map(e => (
                    <div key={e.id} className="flex items-center gap-2 p-2 bg-danger/5 border border-danger/30 rounded">
                      <span className="material-symbols-outlined text-base text-danger">warning</span>
                      <div className="flex-1">
                        <p className="text-[11px] text-text">{e.details}</p>
                        <p className="text-[10px] text-text-secondary">{e.user} · {e.geo} · {e.device}</p>
                      </div>
                      <span className="text-[10px] text-text-secondary">{new Date(e.ts).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'users' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5">用户</th>
                    <th className="text-left px-2 py-1.5 w-16">角色</th>
                    <th className="text-left px-2 py-1.5 w-16">MFA</th>
                    <th className="text-left px-2 py-1.5 w-16">SSO</th>
                    <th className="text-left px-2 py-1.5 w-24">部门</th>
                    <th className="text-left px-2 py-1.5 w-20">状态</th>
                    <th className="text-left px-2 py-1.5 w-20">最后 IP</th>
                    <th className="text-left px-2 py-1.5 w-16">失败</th>
                    <th className="text-left px-2 py-1.5 w-20">登录</th>
                  </tr>
                </thead>
                <tbody>
                  {USERS.map(u => (
                    <tr key={u.id} className="border-t border-border-light">
                      <td className="px-2 py-1">
                        <div className="text-[11px] font-medium text-text">{u.name}</div>
                        <div className="text-[10px] text-text-secondary font-mono">{u.email}</div>
                      </td>
                      <td className="px-2 py-1"><Badge variant={u.role === 'admin' ? 'danger' : u.role === 'service' ? 'warning' : 'default'}>{u.role}</Badge></td>
                      <td className="px-2 py-1">{u.mfa ? <Badge variant="success">✓</Badge> : <Badge variant="warning">—</Badge>}</td>
                      <td className="px-2 py-1 text-[10px] text-text-secondary">{u.ssoProvider || '密码'}</td>
                      <td className="px-2 py-1 text-text-secondary">{u.department}</td>
                      <td className="px-2 py-1">
                        <Badge variant={u.status === 'active' ? 'success' : u.status === 'locked' ? 'danger' : u.status === 'disabled' ? 'default' : 'warning'}>
                          {u.status}
                        </Badge>
                      </td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text-secondary">{u.lastIp || '—'}</td>
                      <td className="px-2 py-1 text-text-secondary">{u.failedAttempts > 0 ? <Badge variant="danger">{u.failedAttempts}</Badge> : '0'}</td>
                      <td className="px-2 py-1 text-[10px] text-text-secondary">{u.lastLogin > 0 ? new Date(u.lastLogin).toLocaleDateString() : '从未'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'events' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-1 border-b border-border-light flex items-center gap-1">
                <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
                  {(['all', 'high', 'failure'] as const).map(f => (
                    <button key={f} onClick={() => setFilter(f)} className={'px-2 h-5 rounded text-[10px] ' + (filter === f ? 'bg-surface-high text-text' : 'text-text-secondary')}>{f}</button>
                  ))}
                </div>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5 w-20">时间</th>
                    <th className="text-left px-2 py-1.5 w-16">风险</th>
                    <th className="text-left px-2 py-1.5 w-28">用户</th>
                    <th className="text-left px-2 py-1.5 w-24">动作</th>
                    <th className="text-left px-2 py-1.5">资源</th>
                    <th className="text-left px-2 py-1.5 w-20">IP/位置</th>
                    <th className="text-left px-2 py-1.5 w-16">结果</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleEvents.map(e => (
                    <tr key={e.id} className={'border-t border-border-light ' + (e.risk === 'high' ? 'bg-danger/5' : '')}>
                      <td className="px-2 py-1 text-[10px] text-text-secondary whitespace-nowrap">{new Date(e.ts).toLocaleTimeString()}</td>
                      <td className="px-2 py-1"><Badge variant={e.risk === 'high' ? 'danger' : e.risk === 'medium' ? 'warning' : 'default'}>{e.risk}</Badge></td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text">{e.user}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-accent">{e.action}</td>
                      <td className="px-2 py-1 text-text">{e.details}</td>
                      <td className="px-2 py-1 text-[10px]">
                        <div className="font-mono text-text-secondary">{e.ip}</div>
                        <div className="text-text-secondary">{e.geo}</div>
                      </td>
                      <td className="px-2 py-1"><Badge variant={e.result === 'success' ? 'success' : e.result === 'failure' ? 'warning' : 'danger'}>{e.result}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'sessions' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5">用户</th>
                    <th className="text-left px-2 py-1.5 w-32">设备</th>
                    <th className="text-left px-2 py-1.5 w-24">位置</th>
                    <th className="text-left px-2 py-1.5 w-20">IP</th>
                    <th className="text-left px-2 py-1.5 w-16">开始</th>
                    <th className="text-left px-2 py-1.5 w-16">活跃</th>
                    <th className="text-left px-2 py-1.5 w-16">过期</th>
                    <th className="text-left px-2 py-1.5 w-16">状态</th>
                    <th className="text-left px-2 py-1.5 w-16"></th>
                  </tr>
                </thead>
                <tbody>
                  {SEED_SESSIONS.map(s => (
                    <tr key={s.id} className="border-t border-border-light">
                      <td className="px-2 py-1 font-mono text-[10px] text-text">{s.user}</td>
                      <td className="px-2 py-1 text-text-secondary">{s.device}</td>
                      <td className="px-2 py-1 text-text-secondary">{s.geo}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text-secondary">{s.ip}</td>
                      <td className="px-2 py-1 text-[10px] text-text-secondary">{new Date(s.started).toLocaleTimeString()}</td>
                      <td className="px-2 py-1 text-[10px] text-text-secondary">{new Date(s.lastActive).toLocaleTimeString()}</td>
                      <td className="px-2 py-1 text-[10px] text-text-secondary">{s.expires > 0 ? new Date(s.expires).toLocaleTimeString() : '已过期'}</td>
                      <td className="px-2 py-1"><Badge variant={s.active ? 'success' : 'default'}>{s.active ? '活跃' : '已断'}</Badge></td>
                      <td className="px-2 py-1">{s.active && <Button size="xs" icon="logout" variant="danger">强制下线</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'rbac' && (
            <div className="bg-bg border border-border rounded-lg overflow-x-auto">
              <table className="text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="px-2 py-1.5 text-left w-32">资源 \\ 角色</th>
                    {(['admin', 'developer', 'analyst', 'viewer', 'service'] as const).map(r => (
                      <th key={r} className="px-2 py-1.5 w-20 text-center">{r}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PERMISSIONS.map(p => (
                    <tr key={p.resource} className="border-t border-border-light">
                      <td className="px-2 py-1 text-text font-medium">{p.resource}</td>
                      {(['admin', 'developer', 'analyst', 'viewer', 'service'] as const).map(r => {
                        const a = p.actions[r];
                        return (
                          <td key={r} className="px-2 py-1 text-center">
                            <Badge variant={a === 'CRUD' ? 'success' : a === '—' ? 'default' : a === 'R' ? 'info' : 'warning'}>{a}</Badge>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>{USERS.length} 用户</span>
          <span>·</span>
          <span>{SEED_EVENTS.length} 审计事件</span>
          <span>·</span>
          <span>{SEED_SESSIONS.length} 会话</span>
          <span>·</span>
          <span>RBAC: 5 角色 × 8 资源</span>
        </div>
      </div>
    </div>
  );
}
