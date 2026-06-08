// ─────────────────────────────────────────────────────────────────
// 数据脱敏工具 — DataMasking
// - 字段级脱敏规则 (email/phone/id/name/card/ip)
// - 脱敏策略: mask/hash/redact/partial/encrypt/shuffle/synthetic
// - 实时预览脱敏前后效果
// - 批量脱敏 + 规则模板
// - 关联字段自动推断
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type MaskType = 'mask' | 'hash' | 'redact' | 'partial' | 'encrypt' | 'shuffle' | 'synthetic' | 'none';
type FieldKind = 'email' | 'phone' | 'id_card' | 'name' | 'card' | 'ip' | 'address' | 'birth' | 'salary' | 'password' | 'token' | 'custom';

interface Rule {
  id: string;
  field: string;
  kind: FieldKind;
  strategy: MaskType;
  enabled: boolean;
  pattern?: string;
  sample: string;
  preview: string;
  hits: number;
  created: number;
}

interface DataRow {
  id: string;
  source: 'users' | 'orders' | 'logs' | 'payments' | 'employees';
  fields: Record<string, string>;
}

const KIND_LABEL: Record<FieldKind, string> = {
  email: '邮箱', phone: '电话', id_card: '身份证', name: '姓名',
  card: '银行卡', ip: 'IP 地址', address: '地址', birth: '生日',
  salary: '薪资', password: '密码', token: '令牌', custom: '自定义'
};

const STRATEGY_LABEL: Record<MaskType, string> = {
  mask: '掩码遮盖', hash: '哈希替换', redact: '完全删除',
  partial: '部分显示', encrypt: '加密', shuffle: '随机打乱',
  synthetic: '合成假数据', none: '不处理'
};

const SEED_RULES: Rule[] = [
  { id: 'r1', field: 'user.email',  kind: 'email',    strategy: 'partial',  enabled: true, sample: 'alice@example.com',         preview: 'a***@example.com',     hits: 1284, created: Date.now() - 86400000 * 12 },
  { id: 'r2', field: 'user.phone',  kind: 'phone',    strategy: 'mask',     enabled: true, sample: '13800138000',                preview: '138****8000',          hits: 1284, created: Date.now() - 86400000 * 12 },
  { id: 'r3', field: 'user.id_card',kind: 'id_card',  strategy: 'partial',  enabled: true, sample: '110101199003078888',         preview: '110101********8888',   hits: 1284, created: Date.now() - 86400000 * 10 },
  { id: 'r4', field: 'user.name',   kind: 'name',     strategy: 'shuffle',  enabled: false,sample: '张三',                       preview: '李四',                 hits: 0,    created: Date.now() - 86400000 * 8 },
  { id: 'r5', field: 'payment.card',kind: 'card',     strategy: 'partial',  enabled: true, sample: '6222021234567890',           preview: '622202****7890',       hits: 532,  created: Date.now() - 86400000 * 7 },
  { id: 'r6', field: 'log.ip',      kind: 'ip',       strategy: 'partial',  enabled: true, sample: '192.168.1.100',              preview: '192.168.***.***',      hits: 45621, created: Date.now() - 86400000 * 6 },
  { id: 'r7', field: 'user.address',kind: 'address',  strategy: 'redact',   enabled: true, sample: '北京市朝阳区建国路 88 号',   preview: '[已脱敏]',             hits: 892,  created: Date.now() - 86400000 * 5 },
  { id: 'r8', field: 'emp.salary',  kind: 'salary',  strategy: 'encrypt',  enabled: true, sample: '¥250000',                    preview: 'ENC:7f3a9b...',        hits: 0,    created: Date.now() - 86400000 * 4 },
  { id: 'r9', field: 'user.password',kind:'password', strategy: 'hash',     enabled: true, sample: 'P@ssw0rd!',                  preview: '5f4dcc3b...',          hits: 1284, created: Date.now() - 86400000 * 3 },
  { id: 'r10',field: 'api.token',   kind: 'token',    strategy: 'redact',   enabled: true, sample: 'sk-abc123...',               preview: '[REDACTED]',           hits: 89,   created: Date.now() - 86400000 * 2 },
];

const SAMPLE_ROWS: DataRow[] = [
  { id: 'd1', source: 'users',    fields: { name: '张三',    email: 'zhang.san@company.com',   phone: '13800138001', id_card: '110101199001011234', address: '北京市朝阳区建国路 1 号' } },
  { id: 'd2', source: 'users',    fields: { name: '李四',    email: 'li.si@startup.io',        phone: '13900139002', id_card: '310101199203054321', address: '上海市浦东新区世纪大道 88 号' } },
  { id: 'd3', source: 'users',    fields: { name: '王五',    email: 'ww@enterprise.cn',        phone: '13700137003', id_card: '440101198507118765', address: '广州市天河区珠江新城路 12 号' } },
  { id: 'd4', source: 'payments', fields: { name: '赵六',    card: '6222021234567890',          amount: '¥9999.00' } },
  { id: 'd5', source: 'logs',     fields: { ip: '203.0.113.45',                  ts: '2026-06-07 10:23:45' } },
  { id: 'd6', source: 'employees',fields: { name: 'Alice',   salary: '¥450000',                  dept: 'Engineering' } },
];

const TEMPLATES = [
  { id: 't1', name: 'GDPR 合规',   desc: '欧盟通用数据保护条例要求', ruleCount: 8,  frameworks: ['GDPR'] },
  { id: 't2', name: 'PCI DSS 支付',desc: '支付卡行业数据安全标准',   ruleCount: 5,  frameworks: ['PCI DSS'] },
  { id: 't3', name: '中国个保法',  desc: 'PIPL 中国个人信息保护法',  ruleCount: 12, frameworks: ['PIPL'] },
  { id: 't4', name: 'HIPAA 健康',  desc: '美国健康保险可携性法案',   ruleCount: 9,  frameworks: ['HIPAA'] },
  { id: 't5', name: '日志脱敏',    desc: '应用日志字段级脱敏',       ruleCount: 6,  frameworks: ['内部'] },
  { id: 't6', name: '生产数据库',  desc: '核心业务表敏感字段',       ruleCount: 14, frameworks: ['内部', 'SOC 2'] },
];

function applyStrategy(value: string, kind: FieldKind, strategy: MaskType): string {
  if (strategy === 'none' || !value) return value;
  switch (strategy) {
    case 'mask': {
      if (kind === 'phone') return value.slice(0, 3) + '****' + value.slice(-4);
      if (kind === 'card')  return value.slice(0, 6) + '****' + value.slice(-4);
      return value.slice(0, 2) + '****';
    }
    case 'partial': {
      if (kind === 'email') {
        const [u, d] = value.split('@');
        return u.slice(0, 1) + '***@' + d;
      }
      if (kind === 'id_card') return value.slice(0, 6) + '********' + value.slice(-4);
      if (kind === 'card')    return value.slice(0, 6) + '****' + value.slice(-4);
      if (kind === 'phone')   return value.slice(0, 3) + '****' + value.slice(-4);
      if (kind === 'ip')      {
        const p = value.split('.');
        return p[0] + '.' + p[1] + '.***.***';
      }
      return value.slice(0, 2) + '***';
    }
    case 'hash': {
      let h = 0;
      for (let i = 0; i < value.length; i++) h = ((h << 5) - h + value.charCodeAt(i)) | 0;
      return Math.abs(h).toString(16).padStart(8, '0') + '...';
    }
    case 'redact':    return '[已脱敏]';
    case 'encrypt':   return 'ENC:' + Math.random().toString(36).slice(2, 10) + '...';
    case 'shuffle': {
      const arr = value.split('');
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr.join('');
    }
    case 'synthetic': {
      const fakes: Record<FieldKind, string> = {
        email: 'user_redacted_' + Math.floor(Math.random() * 999) + '@example.com',
        phone: '1390000' + Math.floor(Math.random() * 9999).toString().padStart(4, '0'),
        id_card: '110101********1234',
        name: '匿名用户',
        card: '622202****0000',
        ip: '127.0.0.1',
        address: '[已脱敏地址]',
        birth: '1990-01-01',
        salary: '¥*****',
        password: '******',
        token: '[REDACTED]',
        custom: '***',
      };
      return fakes[kind];
    }
  }
}

export function DataMasking({ open, onClose }: Props) {
  const [tab, setTab] = useState<'rules' | 'preview' | 'templates' | 'audit'>('rules');
  const [rules, setRules] = useState<Rule[]>(SEED_RULES);
  const [activeId, setActiveId] = useState<string>(SEED_RULES[0].id);
  const [kindFilter, setKindFilter] = useState<'all' | FieldKind>('all');

  const activeRule = rules.find(r => r.id === activeId) || rules[0];
  const filteredRules = kindFilter === 'all' ? rules : rules.filter(r => r.kind === kindFilter);
  const enabledCount = rules.filter(r => r.enabled).length;
  const totalHits = rules.reduce((s, r) => s + r.hits, 0);

  const sampleRow = SAMPLE_ROWS[0];
  const maskingResult = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(sampleRow.fields)) {
      const matchedRule = rules.find(r => r.enabled && r.field.endsWith('.' + k));
      if (matchedRule) out[k] = applyStrategy(v, matchedRule.kind, matchedRule.strategy);
      else out[k] = v;
    }
    return out;
  }, [rules, sampleRow]);

  if (!open) return null;

  function toggleRule(id: string) {
    setRules(rules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
  }

  function applyTemplate(tid: string) {
    const tpl = TEMPLATES.find(t => t.id === tid);
    if (tpl) alert(`已应用模板: ${tpl.name} (${tpl.ruleCount} 条规则)`);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">visibility_off</span>
          <h2 className="text-sm font-semibold text-text">数据脱敏工具</h2>
          <Badge variant="info">{rules.length} 规则</Badge>
          <Badge variant="success">{enabledCount} 启用</Badge>
          <Badge variant="warning">{totalHits.toLocaleString()} 命中</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="play_arrow" variant="primary">运行</Button>
            <Button size="sm" icon="download">导出</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'rules',     l: `规则 (${rules.length})` },
            { k: 'preview',   l: '实时预览' },
            { k: 'templates', l: `模板 (${TEMPLATES.length})` },
            { k: 'audit',     l: '审计日志' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-72 border-r border-border bg-bg overflow-y-auto">
            <div className="px-3 py-2 border-b border-border-light flex items-center gap-1">
              <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as any)} className="flex-1 bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                <option value="all">所有字段</option>
                {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            {filteredRules.map(rule => (
              <div key={rule.id} onClick={() => setActiveId(rule.id)}
                className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeId === rule.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                <div className="flex items-center gap-1 mb-1">
                  <Badge variant={rule.enabled ? 'success' : 'default'}>{rule.enabled ? '启用' : '禁用'}</Badge>
                  <Badge variant="info">{KIND_LABEL[rule.kind]}</Badge>
                  <code className="text-[10px] text-text-secondary font-mono ml-auto">{rule.field}</code>
                </div>
                <div className="text-[11px] font-medium text-text">{STRATEGY_LABEL[rule.strategy]}</div>
                <div className="text-[10px] text-text-secondary mt-0.5 flex items-center gap-1">
                  <span>{rule.hits.toLocaleString()} 命中</span>
                  <span>·</span>
                  <span>{new Date(rule.created).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'rules' && (
              <>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">规则详情</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-[10px] text-text-secondary mb-1">字段路径</p>
                      <code className="text-[11px] font-mono text-text bg-surface-high px-2 py-1 rounded block">{activeRule.field}</code>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary mb-1">字段类型</p>
                      <Badge variant="info">{KIND_LABEL[activeRule.kind]}</Badge>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary mb-1">脱敏策略</p>
                      <Badge variant="warning">{STRATEGY_LABEL[activeRule.strategy]}</Badge>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary mb-1">状态</p>
                      <Badge variant={activeRule.enabled ? 'success' : 'default'}>{activeRule.enabled ? '已启用' : '已禁用'}</Badge>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-border-light">
                    <p className="text-[10px] text-text-secondary mb-1">样例数据</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-bg border border-border-light rounded p-2">
                        <p className="text-[10px] text-text-secondary mb-1">原始</p>
                        <code className="text-[11px] font-mono text-text">{activeRule.sample}</code>
                      </div>
                      <div className="bg-bg border border-accent/30 rounded p-2">
                        <p className="text-[10px] text-accent mb-1">脱敏后</p>
                        <code className="text-[11px] font-mono text-text">{activeRule.preview}</code>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Button size="sm" variant={activeRule.enabled ? 'secondary' : 'primary'} icon={activeRule.enabled ? 'pause' : 'play_arrow'} onClick={() => toggleRule(activeRule.id)}>
                      {activeRule.enabled ? '停用' : '启用'}
                    </Button>
                    <Button size="sm" icon="edit">编辑</Button>
                    <Button size="sm" icon="science">测试</Button>
                    <Button size="sm" icon="content_copy">复制</Button>
                    <Button size="sm" icon="delete" variant="danger">删除</Button>
                  </div>
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">脱敏策略说明</h3>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    {Object.entries(STRATEGY_LABEL).map(([k, v]) => (
                      <div key={k} className="flex gap-2 p-2 bg-surface-high rounded">
                        <span className="material-symbols-outlined text-base text-accent">check_circle</span>
                        <div>
                          <p className="font-medium text-text">{v}</p>
                          <p className="text-[10px] text-text-secondary">
                            {k === 'mask' && '固定字符替换中间部分,如 138****8000'}
                            {k === 'partial' && '保留首尾部分,中间遮盖'}
                            {k === 'hash' && '单向哈希,不可逆'}
                            {k === 'redact' && '完全删除,用占位符替代'}
                            {k === 'encrypt' && '可逆加密,需要密钥'}
                            {k === 'shuffle' && '字符随机打乱'}
                            {k === 'synthetic' && '生成合成的假数据'}
                            {k === 'none' && '不进行脱敏处理'}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {tab === 'preview' && (
              <>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">单行预览 ({sampleRow.source})</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead className="text-text-secondary">
                        <tr className="border-b border-border-light">
                          <th className="text-left py-1.5 px-2">字段</th>
                          <th className="text-left py-1.5 px-2">原始值</th>
                          <th className="text-center py-1.5 px-2">→</th>
                          <th className="text-left py-1.5 px-2">脱敏后</th>
                          <th className="text-left py-1.5 px-2">规则</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(sampleRow.fields).map(([k, v]) => {
                          const matched = rules.find(r => r.enabled && r.field.endsWith('.' + k));
                          return (
                            <tr key={k} className="border-b border-border-light">
                              <td className="py-1.5 px-2"><code className="font-mono text-accent">{k}</code></td>
                              <td className="py-1.5 px-2 text-text">{v}</td>
                              <td className="py-1.5 px-2 text-center text-text-secondary">→</td>
                              <td className="py-1.5 px-2">
                                {matched ? (
                                  <code className="font-mono text-success">{applyStrategy(v, matched.kind, matched.strategy)}</code>
                                ) : (
                                  <span className="text-text-secondary text-[10px]">无规则</span>
                                )}
                              </td>
                              <td className="py-1.5 px-2">
                                {matched ? <Badge variant="info">{STRATEGY_LABEL[matched.strategy]}</Badge> : <span className="text-text-secondary text-[10px]">-</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">多源样本对比</h3>
                  <div className="space-y-2">
                    {SAMPLE_ROWS.slice(1).map(row => {
                      const masked: Record<string, string> = {};
                      for (const [k, v] of Object.entries(row.fields)) {
                        const matched = rules.find(r => r.enabled && r.field.endsWith('.' + k));
                        masked[k] = matched ? applyStrategy(v, matched.kind, matched.strategy) : v;
                      }
                      return (
                        <div key={row.id} className="bg-surface-high rounded p-2">
                          <Badge variant="info">{row.source}</Badge>
                          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-mono">
                            {Object.entries(row.fields).map(([k, v]) => (
                              <span key={k}><span className="text-text-secondary">{k}:</span> <span className="text-text-secondary line-through mr-1">{v}</span><span className="text-accent">{masked[k]}</span></span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            {tab === 'templates' && (
              <div className="grid grid-cols-2 gap-3">
                {TEMPLATES.map(tpl => (
                  <div key={tpl.id} className="bg-bg border border-border-light rounded-lg p-3">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <h3 className="text-xs font-semibold text-text">{tpl.name}</h3>
                        <p className="text-[10px] text-text-secondary mt-0.5">{tpl.desc}</p>
                      </div>
                      <Badge variant="info">{tpl.ruleCount} 规则</Badge>
                    </div>
                    <div className="flex flex-wrap gap-1 mb-2">
                      {tpl.frameworks.map(f => <Badge key={f} variant="warning">{f}</Badge>)}
                    </div>
                    <Button size="sm" icon="download" onClick={() => applyTemplate(tpl.id)}>应用模板</Button>
                  </div>
                ))}
              </div>
            )}

            {tab === 'audit' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">脱敏审计日志</h3>
                <div className="space-y-1 text-[11px]">
                  {[
                    { ts: Date.now() - 3600000, user: 'admin',  action: 'RUN',    target: 'production_db', count: 1284, status: 'ok' },
                    { ts: Date.now() - 7200000, user: 'admin',  action: 'EDIT',   target: 'r6: log.ip', detail: 'partial → mask' },
                    { ts: Date.now() - 86400000,user: 'carol',  action: 'APPLY',  target: 'template: GDPR' },
                    { ts: Date.now() - 172800000,user: 'alice', action: 'CREATE', target: 'r10: api.token' },
                    { ts: Date.now() - 259200000,user: 'admin', action: 'RUN',    target: 'staging_db',     count: 532,  status: 'ok' },
                  ].map((log, i) => (
                    <div key={i} className="flex items-center gap-2 py-1.5 border-b border-border-light">
                      <span className="text-text-secondary text-[10px] w-20 shrink-0">{new Date(log.ts).toLocaleString().slice(0, 16)}</span>
                      <Badge variant="info">{log.action}</Badge>
                      <code className="text-[10px] font-mono text-text flex-1">{log.target}</code>
                      {log.count !== undefined && <span className="text-[10px] text-text-secondary">{log.count} 条</span>}
                      <span className="text-[10px] text-text-secondary">by {log.user}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
